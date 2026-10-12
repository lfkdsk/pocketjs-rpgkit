import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AttractController } from "../src/engine/attract.ts";
import {
  MapNotReadyError,
  MAP_SCHEMA_HASH,
  assertShellManifestFresh,
  canonicalMapJson,
  createJsonMapRepository,
  decodeMapEntryBytes,
  mapChecksum,
  mapManifestHash,
  resolveMapManifestHash,
  sha256Text,
  validateMapDefStructure,
} from "../src/engine/map-repository.ts";
import {
  acquireSessionMap,
  createSession,
  prepareSessionMapStep,
  prepareSessionMap,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import {
  canonicalJson,
  createSnapshot,
  encodeEnvelope,
  fnv1aText,
  utf8Encode,
} from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import { rpgMakerTextRuntime } from "../src/engine/rpgmaker-text.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { MapDef, Project, ProjectShell } from "../src/engine/types.ts";
import type { MapRepository } from "../src/engine/types.ts";
import schema from "../src/data/schema.json";

const MAP_COUNT = 24;

function map(id: string, next: string): MapDef {
  return {
    id,
    name: id,
    width: 4,
    height: 4,
    sheets: ["tiles"],
    ground: new Array(16).fill("tiles.0"),
    events: [{
      id: "door",
      x: 1,
      y: 0,
      pages: [{
        trigger: "action",
        commands: [{ op: "transfer", map: next, x: 1, y: 1, dir: "up" }],
      }],
    }],
  };
}

function fixture(): Project {
  const ids = Array.from({ length: MAP_COUNT }, (_, i) => `map_${String(i).padStart(2, "0")}`);
  return {
    format: "rpgkit-project/v1",
    title: "repository fixture",
    tileSize: 16,
    start: { map: ids[0]!, x: 1, y: 1, dir: "up" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: ids.map((id, i) => map(id, ids[(i + 1) % ids.length]!)),
  };
}

interface Tracking {
  session: Session;
  reads: string[];
  releases: string[][];
  split: ReturnType<typeof splitProjectMaps>;
}

function trackingSession(project = fixture(), hz = 60): Tracking {
  const split = splitProjectMaps(project);
  const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
  const reads: string[] = [];
  const releases: string[][] = [];
  const base = createJsonMapRepository(split.shell.mapIndex, {
    read(entry) {
      reads.push(entry);
      return files.get(entry);
    },
  });
  const repository = {
    meta: base.meta,
    acquire: base.acquire,
    releaseExcept(ids: readonly string[]) {
      releases.push([...ids]);
      base.releaseExcept(ids);
    },
  };
  return { session: createSession(split.shell, hz, repository), reads, releases, split };
}

function pulse(session: Session, state: SessionState): SessionState {
  let next = stepSession(session, state, { buttons: 0, confirmEdge: true });
  next = stepSession(session, next, { buttons: 0 });
  return next;
}

function semanticState(state: SessionState): unknown {
  const { frame: _hostFrame, ...rest } = state;
  return rest;
}

describe("sharded map repository", () => {
  test("SHA-256 matches standard vectors", () => {
    expect(sha256Text("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(MAP_SCHEMA_HASH).toBe(sha256Text(canonicalJson(schema)));
  });

  test("checksum verification defaults by source type and can be overridden", async () => {
    const split = splitProjectMaps(fixture());
    const start = split.entries[0]!;
    const changedBytes = `${start.text} `;

    const local = createJsonMapRepository(split.shell.mapIndex, {
      read: () => changedBytes,
    });
    expect(local.acquire(start.meta.id).id).toBe(start.meta.id);

    const verifiedLocal = createJsonMapRepository(split.shell.mapIndex, {
      read: () => changedBytes,
    }, { verify: true });
    expect(() => verifiedLocal.acquire(start.meta.id)).toThrow(/checksum mismatch/);

    const prepared = createJsonMapRepository(split.shell.mapIndex, {
      read: () => changedBytes,
      prepare: async () => {},
    });
    expect(() => prepared.acquire(start.meta.id)).toThrow(/checksum mismatch/);

    const trustedPrepared = createJsonMapRepository(split.shell.mapIndex, {
      read: () => changedBytes,
      prepare: async () => {},
    }, { verify: false });
    await trustedPrepared.prepare!(start.meta.id);
    expect(trustedPrepared.acquire(start.meta.id).id).toBe(start.meta.id);
  });

  test("a text-capable source prefers readText without reading bytes", () => {
    const split = splitProjectMaps(fixture());
    const start = split.entries[0]!;
    let textReads = 0;
    let byteReads = 0;
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read() {
        byteReads++;
        throw new Error("byte fallback must not run");
      },
      readText(entry) {
        textReads++;
        return entry === start.path ? start.text : undefined;
      },
    });

    expect(repository.acquire(start.meta.id)).toEqual(fixture().maps[0]);
    expect(textReads).toBe(1);
    expect(byteReads).toBe(0);
  });

  test("verified text and byte sources hash the same UTF-8 payload", () => {
    const expected = fixture().maps[0]!;
    expected.name = "Caf\u00e9 \ud83d\ude80";
    const text = canonicalJson(expected);
    const bytes = utf8Encode(text);
    const meta = {
      id: expected.id,
      width: expected.width,
      height: expected.height,
      entry: "maps/non-ascii.json",
      sha256: sha256Text(text),
    };
    expect(text).toContain("Caf\u00e9 \ud83d\ude80");

    const fromText = createJsonMapRepository([meta], {
      read: () => { throw new Error("byte fallback must not run"); },
      readText: () => text,
    }, { verify: true });
    const fromBytes = createJsonMapRepository([meta], {
      read: () => bytes,
    }, { verify: true });
    expect(fromText.acquire(expected.id)).toEqual(expected);
    expect(fromBytes.acquire(expected.id)).toEqual(expected);

    const changedText = `${text} `;
    const corruptText = createJsonMapRepository([meta], {
      read: () => { throw new Error("byte fallback must not run"); },
      readText: () => changedText,
    }, { verify: true });
    const corruptBytes = createJsonMapRepository([meta], {
      read: () => utf8Encode(changedText),
    }, { verify: true });
    expect(() => corruptText.acquire(expected.id)).toThrow(/checksum mismatch/);
    expect(() => corruptBytes.acquire(expected.id)).toThrow(/checksum mismatch/);
  });

  test("an unavailable readText keeps local-missing and async-not-ready errors", () => {
    const split = splitProjectMaps(fixture());
    let byteReads = 0;
    const local = createJsonMapRepository(split.shell.mapIndex, {
      read() {
        byteReads++;
        return split.entries[0]!.bytes;
      },
      readText: () => undefined,
    });
    expect(() => local.acquire("map_00")).toThrow(/missing entry/);
    expect(byteReads).toBe(0);

    const remote = createJsonMapRepository(split.shell.mapIndex, {
      read() {
        byteReads++;
        return split.entries[0]!.bytes;
      },
      readText: () => undefined,
      prepare: async () => {},
    });
    expect(() => remote.acquire("map_00")).toThrow(MapNotReadyError);
    expect(() => remote.acquire("map_00")).toThrow(/not ready/);
    expect(byteReads).toBe(0);
  });

  test("readText acquisition still takes two steps and then hits the cache", () => {
    const split = splitProjectMaps(fixture());
    const start = split.entries[0]!;
    let textReads = 0;
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: () => { throw new Error("byte fallback must not run"); },
      readText(entry) {
        textReads++;
        return entry === start.path ? start.text : undefined;
      },
    }, { verify: true });

    expect(repository.acquireStep!(start.meta.id)).toBeUndefined();
    expect(textReads).toBe(1);
    const ready = repository.acquireStep!(start.meta.id)!;
    expect(ready).toEqual(fixture().maps[0]);
    expect(textReads).toBe(1);
    expect(repository.acquireStep!(start.meta.id)).toBe(ready);
    expect(repository.acquire(start.meta.id)).toBe(ready);
    expect(textReads).toBe(1);
  });

  test("missing local entries are errors while async entries can be prepared", () => {
    const split = splitProjectMaps(fixture());
    const local = createJsonMapRepository(split.shell.mapIndex, { read: () => undefined });
    expect(() => local.acquire("map_00")).toThrow(/missing entry/);
    try {
      local.acquire("map_00");
    } catch (error) {
      expect(error).not.toBeInstanceOf(MapNotReadyError);
    }

    const remote = createJsonMapRepository(split.shell.mapIndex, {
      read: () => undefined,
      prepare: async () => {},
    });
    expect(() => remote.acquire("map_00")).toThrow(MapNotReadyError);
    expect(() => remote.acquire("map_00")).toThrow(/not ready/);
  });

  test("an inline session reports its own unknown maps without mentioning a repository", () => {
    const session = createSession(fixture());
    expect(() => acquireSessionMap(session, "missing")).toThrow("session: unknown map missing");
  });

  test("the splitter emits sorted, byte-stable shell and map entries", () => {
    const project = fixture();
    project.maps.reverse();
    const a = splitProjectMaps(project);
    const b = splitProjectMaps(project);
    expect(a.shellText).toBe(b.shellText);
    expect(a.files.map((file) => [file.path, [...file.bytes]]))
      .toEqual(b.files.map((file) => [file.path, [...file.bytes]]));
    expect(a.shell.mapIndex.map((entry) => entry.id)).toEqual(
      [...a.shell.mapIndex.map((entry) => entry.id)].sort(),
    );
    expect(validateSchema(schema, a.shell)).toEqual([]);
    for (const entry of a.entries) {
      expect(entry.meta.sha256).toBe(sha256Text(entry.text));
      expect(entry.meta.sha256).toBe(mapChecksum(JSON.parse(entry.text)));
    }
  });

  test("declared manifests are trusted for package startup and can be strictly verified", () => {
    const split = splitProjectMaps(fixture());
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const repository = () => createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });
    const changed = { ...split.shell, title: "changed after splitting" };

    const trusted = createSession(changed, 60, { maps: repository() });
    expect(trusted.content?.manifest).toBe(split.shell.mapManifestHash);
    expect(() => createSession(changed, 60, {
      maps: repository(),
      verifyMapManifest: true,
    })).toThrow(/manifest hash mismatch/);

    const unhashed = { ...changed, mapManifestHash: undefined };
    const computed = createSession(unhashed, 60, { maps: repository() });
    expect(computed.content?.manifest).toBe(mapManifestHash(unhashed));
    expect(computed.content?.manifest).not.toBe(split.shell.mapManifestHash);

    expect(() => createSession({ ...split.shell, mapManifestHash: "invalid" }, 60, {
      maps: repository(),
    })).toThrow(/invalid shell manifest hash/);
    const duplicate = {
      ...split.shell,
      mapIndex: split.shell.mapIndex.map((entry, index) => index === 1
        ? { ...entry, id: split.shell.mapIndex[0]!.id }
        : entry),
    };
    expect(() => createSession(duplicate, 60, { maps: repository() }))
      .toThrow(/duplicate map id/);
  });

  test("map entries are stable ASCII JSON and the byte reader decodes in bounded chunks", () => {
    const project = fixture();
    project.maps[0]!.name = "Caf\u00e9 \ud83d\ude80";
    project.maps[0]!.width = 256;
    project.maps[0]!.height = 40;
    project.maps[0]!.ground = new Array(256 * 40).fill("tiles.0");
    const first = splitProjectMaps(project);
    const second = splitProjectMaps(project);
    const entry = first.entries[0]!;
    expect(entry.text).toBe(second.entries[0]!.text);
    expect(entry.text).not.toMatch(/[^\x00-\x7f]/);
    expect(entry.text).toContain("Caf\\u00e9 \\ud83d\\ude80");
    expect(JSON.parse(entry.text)).toEqual(project.maps[0]);
    expect(entry.text).toBe(canonicalMapJson(project.maps[0]!));
    expect(decodeMapEntryBytes(entry.bytes)).toBe(entry.text);

    const legacyUtf8 = utf8Encode('{"name":"Caf\u00e9 \ud83d\ude80"}');
    expect(decodeMapEntryBytes(legacyUtf8)).toBe('{"name":"Caf\u00e9 \ud83d\ude80"}');
    expect(() => decodeMapEntryBytes(new Uint8Array([0xc0, 0x80]))).toThrow(/invalid UTF-8/);
  });

  test("the repository accepts raw entry bytes", () => {
    const split = splitProjectMaps(fixture());
    const files = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    }, { verify: true });
    expect(repository.acquire("map_00")).toEqual(fixture().maps[0]);
  });

  test("a faded transfer prepares fixed units before the original swap tick", () => {
    const project = fixture();
    (project.maps[0]!.events![0]!.pages[0]!.commands[0] as { fade?: number }).fade = 0.4;
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));
    const base = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });
    let fullAcquires = 0;
    let acquireSteps = 0;
    const repository: MapRepository = {
      meta: base.meta,
      acquire(id) {
        fullAcquires++;
        return base.acquire(id);
      },
      acquireStep(id) {
        acquireSteps++;
        return base.acquireStep!(id);
      },
      releaseExcept: base.releaseExcept,
    };
    const session = createSession(split.shell, 60, repository);
    let state = startSession(split.shell, session);
    fullAcquires = 0;

    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    expect(state.fade).toEqual({ phase: "out", left: 12, half: 12 });
    expect(acquireSteps).toBe(0);
    state = stepSession(session, state, { buttons: 0 });
    expect(acquireSteps).toBe(1); // read + ASCII decode + JSON.parse
    expect(session.maps.has("map_01")).toBe(false);
    state = stepSession(session, state, { buttons: 0 });
    expect(acquireSteps).toBe(2); // integrity + structural validation
    expect(session.maps.has("map_01")).toBe(false);
    state = stepSession(session, state, { buttons: 0 }); // compile
    expect(acquireSteps).toBe(2);
    expect(session.maps.has("map_01")).toBe(false);
    for (let tick = 0; tick < 8; tick++) state = stepSession(session, state, { buttons: 0 });
    expect(state.mapId).toBe("map_00");
    state = stepSession(session, state, { buttons: 0 });
    expect(state.mapId).toBe("map_01");
    expect(fullAcquires).toBe(0);
    expect([...session.maps.keys()]).toEqual(["map_01"]);
  });

  test("stages world and passage compilation in separate preparation units", () => {
    const project = fixture();
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });
    const session = createSession(split.shell, 60, repository);

    expect(prepareSessionMapStep(session, "map_01")).toBe(false); // parse
    expect(prepareSessionMapStep(session, "map_01")).toBe(false); // validate
    expect(prepareSessionMapStep(session, "map_01")).toBe(false); // world
    expect(session.preparingMaps.get("map_01")?.world).toBeDefined();
    expect(session.preparingMaps.get("map_01")?.table).toBeUndefined();
    expect(prepareSessionMapStep(session, "map_01")).toBe(true); // passage
    expect(session.preparingMaps.get("map_01")?.table).toBeDefined();
    expect(session.maps.has("map_01")).toBe(false);

    acquireSessionMap(session, "map_01");
    expect(session.preparingMaps.has("map_01")).toBe(false);
    expect(session.maps.has("map_01")).toBe(true);
  });

  test("fade-out preparation units are scheduled by reference ticks at every host hz", () => {
    const project = fixture();
    (project.maps[0]!.events![0]!.pages[0]!.commands[0] as { fade?: number }).fade = 0.4;
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));

    // Repository traffic recorded through a wrapper, one ordered list per host
    // frame: "meta" is prepareSessionMapStep's per-tick manifest check (plus
    // the swap's acquireSessionMap check), "step" is one acquireStep unit,
    // "acquire" is a whole-map acquire (the fade=0 / fallback path).
    type RepoEvent = "meta" | "step" | "acquire";
    interface FadeTrace {
      hz: number;
      ticksPerFrame: number;
      perFrame: RepoEvent[][];
      afterFrame: SessionState[];
      fullAcquires: number;
      mapIds: string[];
    }

    const run = (hz: number): FadeTrace => {
      const base = createJsonMapRepository(split.shell.mapIndex, {
        read: (entry) => files.get(entry),
      });
      let tracing = false;
      const perFrame: RepoEvent[][] = [];
      const afterFrame: SessionState[] = [];
      let fullAcquires = 0;
      const repository: MapRepository = {
        meta(id) {
          if (tracing) perFrame[perFrame.length - 1]!.push("meta");
          return base.meta(id);
        },
        acquire(id) {
          if (tracing) {
            perFrame[perFrame.length - 1]!.push("acquire");
            fullAcquires++;
          }
          return base.acquire(id);
        },
        acquireStep(id) {
          if (tracing) perFrame[perFrame.length - 1]!.push("step");
          return base.acquireStep!(id);
        },
        releaseExcept: base.releaseExcept,
      };
      const session = createSession(split.shell, hz, repository);
      let state = startSession(split.shell, session);
      tracing = true;
      for (let frame = 0; frame < hz * 2; frame++) {
        perFrame.push([]);
        state = stepSession(
          session,
          state,
          frame === 0 ? { buttons: 0, confirmEdge: true } : { buttons: 0 },
        );
        afterFrame.push(state);
      }
      return {
        hz,
        ticksPerFrame: session.ticksPerFrame,
        perFrame,
        afterFrame,
        fullAcquires,
        mapIds: [...session.maps.keys()],
      };
    };

    // Replay the fade state machine over the recorded trace and recover the
    // reference tick of every acquireStep unit. The spec under test: during
    // fade-out the engine prepares exactly one unit per reference tick (a
    // manifest check each tick; an acquireStep on the first two prepares),
    // swaps on the tick fade-out reaches zero (one more manifest check from
    // acquireSessionMap), and never falls back to a whole-map acquire.
    const reconstruct = (trace: FadeTrace, half: number) => {
      const stepTicks: number[] = [];
      let fade: { phase: "out" | "in"; left: number; half: number } | null = null;
      let tick = 0;
      let prepares = 0;
      let metas = 0;
      for (let frame = 0; frame < trace.perFrame.length; frame++) {
        const events = trace.perFrame[frame]!;
        let i = 0;
        const take = (kind: RepoEvent): void => {
          if (events[i] !== kind) {
            throw new Error(
              `hz ${trace.hz} frame ${frame} tick ${tick}: expected ${kind}, ` +
                `saw ${events[i] ?? "nothing"} (frame trace ${JSON.stringify(events)})`,
            );
          }
          i++;
        };
        for (let t = 0; t < trace.ticksPerFrame; t++) {
          // Input edges are delivered on the first reference tick of the
          // first host frame, so the transfer command executes on tick 0 at
          // every host hz; the fade state machine starts on tick 1.
          if (!fade && frame === 0 && t === 0) {
            fade = { phase: "out", left: half, half };
            tick++;
            continue;
          }
          if (fade?.phase === "out") {
            take("meta");
            metas++;
            prepares++;
            if (prepares <= 2) {
              take("step");
              stepTicks.push(tick);
            }
          }
          if (fade) {
            fade.left--;
            if (fade.left === 0) {
              if (fade.phase === "out") {
                take("meta");
                metas++;
                fade.phase = "in";
                fade.left = fade.half;
              } else {
                fade = null;
              }
            }
          }
          tick++;
        }
        if (i !== events.length) {
          throw new Error(
            `hz ${trace.hz} frame ${frame}: ${events.length - i} unexpected event(s) ` +
              JSON.stringify(events.slice(i)),
          );
        }
        if (!fade) break;
      }
      return { stepTicks, prepares, metas };
    };

    // Calibrate on the 60 Hz fold: one host frame is one reference tick, so a
    // fade.left === half after frame 0 proves the transfer executed on tick 0
    // itself (the fade branch runs at the top of a tick, after the transfer).
    const calib = run(60);
    expect(calib.afterFrame[0]!.fade).toEqual({ phase: "out", left: 12, half: 12 });
    const half = calib.afterFrame[0]!.fade!.half;

    const profiles = [calib, run(30), run(20), run(4)].map((trace) => {
      const { stepTicks, prepares, metas } = reconstruct(trace, half);
      expect(trace.afterFrame[trace.afterFrame.length - 1]!.mapId).toBe("map_01");
      expect(trace.mapIds).toEqual(["map_01"]);
      return {
        hz: trace.hz,
        stepTicks,
        prepares,
        metas,
        fullAcquires: trace.fullAcquires,
      };
    });

    for (const profile of profiles) {
      // The two parse/validate units fire on the first two fade-out ticks,
      // counted in reference ticks — identical at 60/30/20/4 Hz.
      expect(profile.stepTicks).toEqual([1, 2]);
      expect(profile.prepares).toBe(12);
      expect(profile.metas).toBe(13); // 12 per-tick checks + the swap check
      expect(profile.fullAcquires).toBe(0); // no whole-map acquire during fade
    }
    expect(
      new Set(profiles.map(({ hz: _hz, ...rest }) => JSON.stringify(rest))).size,
    ).toBe(1);
  });

  test("a zero-fade transfer keeps its all-at-once acquire", () => {
    const split = splitProjectMaps(fixture());
    const files = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));
    const base = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });
    let fullAcquires = 0;
    let acquireSteps = 0;
    const repository: MapRepository = {
      meta: base.meta,
      acquire(id) {
        fullAcquires++;
        return base.acquire(id);
      },
      acquireStep(id) {
        acquireSteps++;
        return base.acquireStep!(id);
      },
      releaseExcept: base.releaseExcept,
    };
    const session = createSession(split.shell, 60, repository);
    let state = startSession(split.shell, session);
    fullAcquires = 0;
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    expect(state.mapId).toBe("map_01");
    expect(state.fade).toBeNull();
    expect(fullAcquires).toBe(1);
    expect(acquireSteps).toBe(0);
  });

  test("the splitter rejects a map that fails the full command schema", () => {
    const project = fixture();
    (project.maps[0]!.events![0]!.pages[0]!.commands[0] as { op: string }).op = "unknown";
    expect(() => splitProjectMaps(project)).toThrow(/schema mismatch/);
  });

  test("runtime structure validation checks compilation-critical shapes", () => {
    const valid = fixture().maps[0]!;
    const cases: [string, (map: Record<string, unknown>) => void, RegExp][] = [
      ["id", (map) => { map.id = 7; }, /id must be a non-empty string/],
      ["width", (map) => { map.width = 0; }, /width must be a positive integer/],
      ["height", (map) => { map.height = 1.5; }, /height must be a positive integer/],
      ["ground array", (map) => { map.ground = null; }, /ground must be an array/],
      ["ground length", (map) => { (map.ground as unknown[]).pop(); }, /ground has 15 cells/],
      ["ground element", (map) => { (map.ground as unknown[])[0] = 4; }, /ground cell 0/],
      ["upper shape", (map) => { map.upper = ["bad"]; }, /upper entries/],
      ["upper bound", (map) => { map.upper = [[16, "tiles.0"]]; }, /upper index 16 out of range/],
      ["passage bound", (map) => { map.passage = [[-1, "pass"]]; }, /passage index -1 out of range/],
      ["regions shape", (map) => { map.regions = ["bad"]; }, /regions entries must be/],
      ["regions index bound", (map) => { map.regions = [[16, 1]]; }, /regions index 16 out of range/],
      ["regions tag high", (map) => { map.regions = [[0, 256]]; }, /regions tag 256 out of range/],
      ["regions tag low", (map) => { map.regions = [[0, 0]]; }, /regions tag 0 out of range/],
      ["terrain shape", (map) => { map.terrain = [2]; }, /terrain entries must be/],
      ["terrain tag high", (map) => { map.terrain = [[0, 8]]; }, /terrain tag 8 out of range/],
      ["tiles shape", (map) => { map.tiles = [3]; }, /tiles entries must be/],
      ["tiles quad short", (map) => { map.tiles = [[0, [1, 2, 3]]]; }, /tiles entries must be/],
      ["tiles quad element", (map) => { map.tiles = [[0, [1, 2, 3, "x"]]]; }, /tiles entries must be/],
      ["tiles index bound", (map) => { map.tiles = [[16, [1, 2, 3, 4]]]; }, /tiles index 16 out of range/],
      ["events", (map) => { map.events = null; }, /events must be an array/],
      ["pages", (map) => { (map.events as Record<string, unknown>[])[0]!.pages = null; }, /pages must be an array/],
      ["commands", (map) => {
        const event = (map.events as Record<string, unknown>[])[0]!;
        (event.pages as Record<string, unknown>[])[0]!.commands = null;
      }, /commands must be an array/],
    ];
    for (const [name, mutate, error] of cases) {
      const value = structuredClone(valid) as unknown as Record<string, unknown>;
      mutate(value);
      expect(() => validateMapDefStructure(value), name).toThrow(error);
    }
  });

  test("runtime defaults to structural validation and supports full validation", () => {
    const split = splitProjectMaps(fixture());
    const start = split.entries[0]!;
    const invalidCommand = JSON.parse(start.text) as MapDef;
    (invalidCommand.events![0]!.pages[0]!.commands[0] as { op: string }).op = "unknown";
    const text = canonicalJson(invalidCommand);
    const source = { read: () => text };
    expect(createJsonMapRepository(split.shell.mapIndex, source).acquire(start.meta.id))
      .toEqual(invalidCommand);
    const full = createJsonMapRepository(split.shell.mapIndex, source, { validate: "full" });
    expect(() => full.acquire(start.meta.id)).toThrow(/schema mismatch/);
  });

  test("structural validation rejects malformed regions/terrain/tiles payloads", () => {
    // The round-3 review probe: a sharded map whose regions/terrain/tiles
    // planes carry malformed entries passed the default structural check and
    // only died later in createWorld with a context-less TypeError. The
    // structure check now covers the three planes, so the default repository
    // rejects the payload at acquire time with a contextual error.
    const split = splitProjectMaps(fixture());
    const start = split.entries[0]!;
    const cases: [string, unknown, RegExp][] = [
      ["regions scalar", [1], /regions entries must be/],
      ["terrain scalar", [2], /terrain entries must be/],
      ["tiles scalar", [3], /tiles entries must be/],
      ["regions tag high", [[0, 999]], /regions tag 999 out of range/],
      ["tiles quad short", [[0, [1, 2, 3]]], /tiles entries must be/],
    ];
    for (const [name, value, error] of cases) {
      const map = JSON.parse(start.text) as Record<string, unknown>;
      const plane = name.startsWith("regions") ? "regions" : name.startsWith("terrain") ? "terrain" : "tiles";
      map[plane] = value;
      const text = canonicalJson(map);
      const repo = createJsonMapRepository(split.shell.mapIndex, { read: () => text });
      expect(() => repo.acquire(start.meta.id), name).toThrow(error);
    }
  });

  test("startup acquires only the start map; transfers evict and revisits reacquire", () => {
    const { session, reads, releases, split } = trackingSession();
    let state = startSession(split.shell, session);
    expect(reads).toEqual(["maps/map_00.json"]);
    expect([...session.maps.keys()]).toEqual(["map_00"]);
    for (let i = 1; i <= MAP_COUNT; i++) {
      state = pulse(session, state);
      expect(state.mapId).toBe(`map_${String(i % MAP_COUNT).padStart(2, "0")}`);
      expect([...session.maps.keys()]).toEqual([state.mapId]);
      expect([...session.worlds.keys()]).toEqual([state.mapId]);
      expect([...session.tables.keys()]).toEqual([state.mapId]);
    }
    expect(reads).toHaveLength(MAP_COUNT + 1);
    expect(reads.at(-1)).toBe("maps/map_00.json");
    expect(releases.at(-1)).toEqual(["map_00"]);
  });

  test("a save restores onto an already released map and rejects another build", () => {
    const first = trackingSession();
    let state = startSession(first.split.shell, first.session);
    for (let i = 0; i < 7; i++) state = pulse(first.session, state);
    const savedMap = state.mapId;
    const envelope = encodeEnvelope(
      createSnapshot(state.mapId, state.move, state.interp, 0),
      first.session.content,
    );
    state = pulse(first.session, state);
    expect(first.session.maps.has(savedMap)).toBe(false);
    const restored = restoreSessionEnvelope(first.session, envelope);
    expect(restored.mapId).toBe(savedMap);
    expect([...first.session.maps.keys()]).toEqual([savedMap]);

    const changed = fixture();
    changed.maps[12]!.name = "changed content";
    const second = trackingSession(changed);
    const readsBefore = second.reads.length;
    expect(() => restoreSessionEnvelope(second.session, envelope)).toThrow(/manifest hash/);
    expect(second.reads).toHaveLength(readsBefore);
  });

  test("a save survives a change of the presentation-only uiText table", () => {
    // uiText is a root presentation field: it never reaches the reducer,
    // the session or the save codec, so it is excluded from the manifest
    // identity (map-repository.ts MANIFEST_EXCLUDED_ROOT_FIELDS). A save
    // taken under one language's table loads under another's; per-language
    // map content (dialogue in events) is hashed through mapIndex and still
    // changes the identity, as the test above shows.
    const first = trackingSession();
    let state = startSession(first.split.shell, first.session);
    for (let i = 0; i < 7; i++) state = pulse(first.session, state);
    const envelope = encodeEnvelope(
      createSnapshot(state.mapId, state.move, state.interp, 0),
      first.session.content,
    );

    const translated = fixture();
    translated.uiText = { "legend.ok": "确认" };
    const second = trackingSession(translated);
    expect(second.split.shell.mapManifestHash).toBe(first.split.shell.mapManifestHash);
    expect(second.session.content?.manifest).toBe(first.session.content?.manifest);
    const restored = restoreSessionEnvelope(second.session, envelope);
    expect(restored.mapId).toBe(state.mapId);
    expect(restored.interp).toEqual(state.interp);

    // The same shell, only its uiText swapped, hashes identically whether
    // the table is absent, present or replaced.
    const shell = first.split.shell;
    const base = mapManifestHash(shell);
    expect(mapManifestHash({ ...shell, uiText: { "legend.ok": "确认" } })).toBe(base);
    expect(mapManifestHash({ ...shell, uiText: { "legend.ok": "Bestätigen" } })).toBe(base);
    expect(mapManifestHash({ ...shell, uiText: undefined })).toBe(base);
  });

  test("two runs and four host rates produce identical semantic hashes", () => {
    const drive = (hz: number): string => {
      const { session, split } = trackingSession(fixture(), hz);
      let state = startSession(split.shell, session);
      // One action edge every quarter second; each rate folds the same 60 Hz
      // reference duration and visits the same four maps.
      for (let second = 0; second < 4; second++) {
        state = stepSession(session, state, { buttons: 0, confirmEdge: true });
        for (let frame = 1; frame < hz; frame++) {
          state = stepSession(session, state, { buttons: 0 });
        }
      }
      return fnv1aText(canonicalJson(semanticState(state)));
    };
    const hashes = [60, 30, 20, 4].map(drive);
    expect(hashes).toEqual(new Array(4).fill(hashes[0]));
    expect(drive(60)).toBe(hashes[0]);
  });

  test("an async source pauses before transfer and retries the same input frame", async () => {
    const split = splitProjectMaps(fixture());
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const ready = new Set(["maps/map_00.json"]);
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => ready.has(entry) ? files.get(entry) : undefined,
      prepare: async (entry) => { ready.add(entry); },
    });
    const session = createSession(split.shell, 60, repository);
    const state = startSession(split.shell, session);
    const before = canonicalJson(state);
    const input = { buttons: 0, confirmEdge: true } as const;
    expect(() => stepSession(session, state, input)).toThrow(MapNotReadyError);
    expect(canonicalJson(state)).toBe(before);
    expect([...session.maps.keys()]).toEqual(["map_00"]);
    await prepareSessionMap(session, "map_01");
    const transferred = stepSession(session, state, input);
    expect(transferred.mapId).toBe("map_01");
    expect([...session.maps.keys()]).toEqual(["map_01"]);
  });

  test("an attract fold rolls back before an async map and retries exactly", async () => {
    const split = splitProjectMaps(fixture());
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const ready = new Set(["maps/map_00.json"]);
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => ready.has(entry) ? files.get(entry) : undefined,
      prepare: async (entry) => { ready.add(entry); },
    });
    const tape = new Array(15).fill(0);
    tape[0] = 0x2000;
    const controller = new AttractController(split.shell, tape, {
      hz: 4,
      maps: repository,
    });
    controller.startAttract();
    const before = canonicalJson({
      state: controller.state,
      status: controller.status(),
      length: controller.length,
      folded: controller.foldedMask(),
    });
    expect(() => controller.step(0)).toThrow(MapNotReadyError);
    expect(canonicalJson({
      state: controller.state,
      status: controller.status(),
      length: controller.length,
      folded: controller.foldedMask(),
    })).toBe(before);
    await prepareSessionMap(controller.getSession(), "map_01");
    const retried = controller.step(0);
    expect(retried.state.mapId).toBe("map_01");
    expect(controller.length).toBe(15);
    expect([...controller.getSession().maps.keys()]).toEqual(["map_01"]);
  });

  test("schema, metadata and checksum corruption are rejected before entry", () => {
    const split = splitProjectMaps(fixture());
    const start = split.entries[0]!;
    const badMap = JSON.parse(start.text) as MapDef;
    badMap.ground.pop();
    const badText = canonicalJson(badMap);
    const badIndex = split.shell.mapIndex.map((entry, index) => index === 0
      ? { ...entry, sha256: sha256Text(badText) }
      : entry);
    const repository = createJsonMapRepository(badIndex, {
      read: (entry) => entry === start.path ? badText : split.entries.find((item) => item.path === entry)?.text,
    });
    const shell = { ...split.shell, mapIndex: badIndex, mapManifestHash: undefined };
    expect(() => createSession(shell, 60, repository)).toThrow(/ground has 15 cells/);

    const checksumRepository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => entry === start.path ? `${start.text} ` : split.entries.find((item) => item.path === entry)?.text,
    }, { verify: true });
    expect(() => createSession(split.shell, 60, checksumRepository)).toThrow(/checksum mismatch/);
  });
});

describe("sharded maps keep project system options", () => {
  test("worlds compiled on demand carry system.messageBlocksPlayer", () => {
    const project = { ...fixture(), system: { messageBlocksPlayer: true } };
    const inline = createSession(project, 60);
    expect([...inline.worlds.values()].every((w) => w.messageBlocksPlayer === true)).toBe(true);
    const { session, split } = trackingSession(project);
    let state = startSession(split.shell, session);
    expect(session.worlds.get("map_00")!.messageBlocksPlayer).toBe(true);
    state = pulse(session, state);
    for (let i = 0; i < 40 && state.mapId === "map_00"; i++) {
      state = stepSession(session, state, { buttons: 0 });
    }
    expect(state.mapId).toBe("map_01");
    expect(session.worlds.get("map_01")!.messageBlocksPlayer).toBe(true);
  });

  test("worlds prepared in fade-out units carry system.messageBlocksPlayer", () => {
    const project: Project = { ...fixture(), system: { messageBlocksPlayer: true } };
    (project.maps[0]!.events![0]!.pages[0]!.commands[0] as { fade?: number }).fade = 0.4;
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));
    const base = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });
    let fullAcquires = 0;
    const repository: MapRepository = {
      ...base,
      acquire(id) {
        fullAcquires++;
        return base.acquire(id);
      },
    };
    const session = createSession(split.shell, 60, repository);
    let state = startSession(split.shell, session);
    fullAcquires = 0;
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    for (let i = 0; i < 40 && state.mapId === "map_00"; i++) {
      state = stepSession(session, state, { buttons: 0 });
    }
    expect(state.mapId).toBe("map_01");
    expect(fullAcquires).toBe(0);
    expect(session.worlds.get("map_01")!.messageBlocksPlayer).toBe(true);
  });
});

describe("staged map loading keeps session registrations", () => {
  function stagedExtensionSession(register: boolean) {
    const project = fixture();
    (project.maps[0]!.events![0]!.pages[0]!.commands[0] as { fade?: number }).fade = 0.4;
    project.maps[1]!.events!.push({
      id: "mark",
      x: 3,
      y: 3,
      pages: [{ trigger: "parallel", commands: [
        { op: "ext", call: "demo.mark", args: null },
      ] }],
    });
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));
    const base = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });
    let fullAcquires = 0;
    const repository: MapRepository = {
      ...base,
      acquire(id) {
        fullAcquires++;
        return base.acquire(id);
      },
    };
    const session = createSession(split.shell, 60, {
      maps: repository,
      extensions: register
        ? { initial: null, commands: { "demo.mark": () => ({ ext: "marked" }) } }
        : {},
    });
    const state = startSession(split.shell, session);
    return { session, state, fullAcquires: () => fullAcquires };
  }

  test("a map prepared in fade-out units runs registered extension commands", () => {
    const { session, state: start, fullAcquires } = stagedExtensionSession(true);
    const before = fullAcquires();
    let state = stepSession(session, start, { buttons: 0, confirmEdge: true });
    for (let i = 0; i < 40 && state.mapId === "map_00"; i++) {
      state = stepSession(session, state, { buttons: 0 });
    }
    expect(state.mapId).toBe("map_01");
    expect(fullAcquires()).toBe(before);
    for (let i = 0; i < 40 && state.ext === null; i++) {
      state = stepSession(session, state, { buttons: 0 });
    }
    expect(state.ext).toBe("marked");
  });

  test("an unregistered call in a staged map is rejected like a full acquire", () => {
    const { session, state: start } = stagedExtensionSession(false);
    let state = stepSession(session, start, { buttons: 0, confirmEdge: true });
    expect(() => {
      for (let i = 0; i < 40; i++) state = stepSession(session, state, { buttons: 0 });
    }).toThrow(/unregistered extension calls: command demo\.mark/);
  });

  test("a staged map cannot admit an unregistered RPG Maker screen command", () => {
    const project = fixture();
    (project.maps[0]!.events![0]!.pages[0]!.commands[0] as { fade?: number }).fade = 0.4;
    project.maps[1]!.events!.push({
      id: "storm",
      x: 3,
      y: 3,
      pages: [{
        trigger: "parallel",
        commands: [{ op: "weather", kind: "storm", power: 9, duration: 1, wait: true }],
      }],
    });
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });
    const session = createSession(split.shell, 60, { maps: repository });
    let state = startSession(split.shell, session);
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    expect(() => {
      for (let i = 0; i < 40; i++) state = stepSession(session, state, { buttons: 0 });
    }).toThrow(
      "RPG Maker screen: commands weather require the optional rpgMakerText runtime",
    );
  });
});

describe("sharded map screen capability admission", () => {
  function screenProject(): Project {
    const project = fixture();
    project.maps[1]!.events!.push({
      id: "tone",
      x: 3,
      y: 3,
      pages: [{
        trigger: "parallel",
        commands: [{
          op: "screenTone",
          tone: { r: -30, g: 20, b: 10, gray: 40 },
          duration: 1,
        }],
      }],
    });
    return project;
  }

  test("full lazy acquisition validates before compiling or caching the map", () => {
    const split = splitProjectMaps(screenProject());
    const files = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));
    const repository = () => createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });
    const missing = createSession(split.shell, 60, { maps: repository() });
    expect(() => acquireSessionMap(missing, "map_01")).toThrow(
      "RPG Maker screen: commands screenTone require the optional rpgMakerText runtime",
    );
    expect(missing.maps.has("map_01")).toBe(false);
    expect(missing.worlds.has("map_01")).toBe(false);

    const registered = createSession(split.shell, 60, {
      maps: repository(),
      rpgMakerText: rpgMakerTextRuntime,
    });
    expect(acquireSessionMap(registered, "map_01").id).toBe("map_01");
  });
});

describe("shell manifest freshness check", () => {
  let tempDir = "";

  beforeAll(() => {
    // Real disk round-trip: the check must hold for the bytes a packager
    // writes and reads back. The directory is per-process and removed after.
    tempDir = mkdtempSync(join(import.meta.dir, `.shell-fresh-${process.pid}-`));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("a split shell stays fresh through a JSON disk round-trip", () => {
    const split = splitProjectMaps(fixture());
    const declared = split.shell.mapManifestHash!;
    const path = join(tempDir, "project-shell.json");

    // What a naive packager writes: JSON.stringify of the shell object.
    writeFileSync(path, JSON.stringify(split.shell));
    const roundTripped = JSON.parse(readFileSync(path, "utf8")) as ProjectShell;
    expect(() => assertShellManifestFresh(roundTripped)).not.toThrow();
    expect(resolveMapManifestHash(roundTripped, true)).toBe(declared);

    // The splitter's own canonical bytes, exactly as files[] carries them.
    writeFileSync(path, split.shellText);
    const canonical = JSON.parse(readFileSync(path, "utf8")) as ProjectShell;
    expect(() => assertShellManifestFresh(canonical)).not.toThrow();
    expect(resolveMapManifestHash(canonical, true)).toBe(declared);
  });

  test("any non-hash content change is rejected with both digests", () => {
    const split = splitProjectMaps(fixture());
    const declared = split.shell.mapManifestHash!;
    const cases: [string, (shell: ProjectShell) => ProjectShell][] = [
      ["title", (shell) => ({ ...shell, title: "hand-edited after packaging" })],
      ["mapIndex entry", (shell) => ({
        ...shell,
        mapIndex: shell.mapIndex.map((entry, index) => index === 0
          ? { ...entry, width: 240 }
          : entry),
      })],
      ["system settings", (shell) => ({
        ...shell,
        system: { ...shell.system, messageBlocksPlayer: true },
      })],
      ["start spot", (shell) => ({ ...shell, start: { ...shell.start, x: 2 } })],
    ];
    for (const [name, mutate] of cases) {
      const mutated = mutate(split.shell);
      let caught: unknown;
      try {
        assertShellManifestFresh(mutated);
      } catch (error) {
        caught = error;
      }
      expect(caught, name).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message, name).toMatch(/manifest hash mismatch/);
      expect(message, name).toContain(declared);
      expect(message, name).toContain(mapManifestHash(mutated));
      // The runtime opt-in must reject the same stale declaration.
      expect(() => resolveMapManifestHash(mutated, true), name)
        .toThrow(/manifest hash mismatch/);
    }
  });

  test("a shell without a valid declared hash cannot be checked", () => {
    const split = splitProjectMaps(fixture());
    expect(() => assertShellManifestFresh({ ...split.shell, mapManifestHash: undefined }))
      .toThrow(/declares no mapManifestHash/);
    expect(() => assertShellManifestFresh({ ...split.shell, mapManifestHash: "tampered" }))
      .toThrow(/invalid shell manifest hash/);
  });

  test("a stale declared hash is rejected before an old save can load against changed content", () => {
    // The review's stale-hash reproduction, locked as a test: a save taken
    // against the original content must not restore onto a shell whose content
    // changed while keeping the stale declared hash.
    const split = splitProjectMaps(fixture());
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const repository = () => createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });

    const session = createSession(split.shell, 60, repository());
    let state = startSession(split.shell, session);
    for (let i = 0; i < 5; i++) state = pulse(session, state);
    const envelope = encodeEnvelope(
      createSnapshot(state.mapId, state.move, state.interp, 0),
      session.content,
    );

    const mutated = { ...split.shell, title: "changed after the save was taken" };
    expect(() => assertShellManifestFresh(mutated)).toThrow(/manifest hash mismatch/);
    expect(() => createSession(mutated, 60, {
      maps: repository(),
      verifyMapManifest: true,
    })).toThrow(/manifest hash mismatch/);

    // Documented trust boundary: without the build/test-time check, the
    // runtime trusts the stale declaration and the old save silently loads —
    // which is exactly why packaging apps must run the check.
    const trusted = createSession(mutated, 60, repository());
    expect(trusted.content?.manifest).toBe(split.shell.mapManifestHash);
    expect(restoreSessionEnvelope(trusted, envelope).mapId).toBe(state.mapId);
  });
});
