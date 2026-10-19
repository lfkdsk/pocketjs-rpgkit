// tests/rpgmaker-events.test.ts — the RPG Maker importer's event side:
// command-list tree parsing, per-code mappings and their coverage
// dispositions, message escape codes, move routes, pages, common events,
// and the command catalog. Every converted list is checked against the
// kit schema, and the numeric lowerings are run through the real
// interpreter to prove they compute what MV computes.

import { describe, expect, test } from "bun:test";
import schema from "../src/data/schema.json";
import {
  compile,
  createInterpState,
  createSwitchState,
  createWorld,
  stepInterp,
  type InterpState,
} from "../src/engine/interpreter.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import type { Command, Condition, GameEvent, MapDef, TextBoxLayout } from "../src/engine/types.ts";
import { RM_COMMANDS, RM_COMMAND_BY_CODE, RM_CONDITION_TYPES, RM_ROUTE_CODES, sampleCommands } from "../tools/rpgmaker-import/catalog.ts";
import { Coverage, type Disposition } from "../tools/rpgmaker-import/coverage.ts";
import {
  convertCommands,
  convertCommonEvent,
  convertMoveRoute,
  convertPage,
  convertPageConditions,
  parseTree,
  wrap,
  type EventContext,
} from "../tools/rpgmaker-import/events.ts";
import { audioId } from "../tools/rpgmaker-import/ids.ts";
import { parseRmPlugins } from "../tools/rpgmaker-import/semantics.ts";
import { BrowserRpgMakerSource, loadBrowserRmProject, type BrowserDirectoryHandle } from "../editor/studio/rpgmaker-import-browser-source.ts";
import type { RmCommand, RmEventPage, RmMap, RmPageConditions, RmProject } from "../tools/rpgmaker-import/rm-types.ts";
import { convertMessage } from "../tools/rpgmaker-import/text.ts";

test("browser indexes only js/plugins.js and loads inert declarations", async () => {
  let enumerated = false;
  let implementationRead = false;
  const registry = `var $plugins = ${JSON.stringify([{ name: "Fixture", status: true, description: "Safe", parameters: { nested: '{"x":1}' } }])};`;
  const js: BrowserDirectoryHandle = {
    kind: "directory", name: "js",
    async *values() { enumerated = true; throw new Error("js must not be enumerated"); },
    async getFileHandle(name) {
      expect(name).toBe("plugins.js");
      return { kind: "file", name, async getFile() {
        return { name, size: registry.length, text: async () => registry,
          arrayBuffer: async () => { implementationRead = true; throw new Error("no implementation bytes"); } };
      } };
    },
  };
  const root: BrowserDirectoryHandle = {
    kind: "directory", name: "fixture",
    async *values() {
      yield { kind: "directory" as const, name: "data", async *values() {
        yield { kind: "file" as const, name: "System.json", async getFile() {
          const text = JSON.stringify({ gameTitle: "Fixture", partyMembers: [], startMapId: 0 });
          return { name: "System.json", size: text.length, text: async () => text,
            arrayBuffer: async () => new ArrayBuffer(0) };
        } };
      } };
      yield js;
    },
  };
  const source = await BrowserRpgMakerSource.index(root);
  const loaded = await loadBrowserRmProject(source);
  expect(loaded.project.plugins).toEqual([{ name: "Fixture", status: true,
    description: "Safe", parameters: { nested: '{"x":1}' } }]);
  expect(enumerated).toBe(false);
  expect(implementationRead).toBe(false);
  expect(source.isFile("js/Fixture.js")).toBe(false);
});

test("plugin registry parses inert declarations without evaluating JavaScript", () => {
  const plugins = parseRmPlugins('var $plugins = [{"name":"Demo","status":true,"description":"fixture","parameters":{"count":"2","nested":"{\\\"a\\\":1}"}}];');
  expect(plugins).toEqual([{ name: "Demo", status: true, description: "fixture", parameters: { count: "2", nested: '{"a":1}' } }]);
  expect(parseRmPlugins('// Generated registry\nvar $plugins = [];')).toEqual([]);
  expect(parseRmPlugins(`var $plugins = ${JSON.stringify([
    { name: "First", status: false, description: "disabled", parameters: { count: "0" } },
    { name: "Second", status: true, description: "enabled", parameters: { value: "02" } },
  ])};`).map(({ name, status, parameters }) => ({ name, status, parameters }))).toEqual([
    { name: "First", status: false, parameters: { count: "0" } },
    { name: "Second", status: true, parameters: { value: "02" } },
  ]);
  const source = { format: "rpgkit-project/v1", title: "fixture", tileSize: 16, start: { map: "a", x: 0, y: 0, dir: "down" }, sheets: [{ id: "s", cols: 1, rows: 1, pak: "p" }], items: [], maps: [{ id: "a", name: "Fixture", width: 1, height: 1, sheets: ["s"], ground: [null], events: [] }], plugins };
  expect(validateSchema(schema, source)).toEqual([]);
  expect(() => parseRmPlugins('var $plugins = []; globalThis.hacked = true;')).toThrow("expected a JSON plugin registry");
  expect(() => parseRmPlugins('var $plugins = [{"name":"Demo","status":true,"description":"fixture","parameters":{"x":1}}];')).toThrow("invalid plugin declaration");
});

// --- fixtures ----------------------------------------------------------------

const C = (code: number, indent: number, parameters: unknown[] = []): RmCommand => ({ code, indent, parameters });
const END = (indent: number): RmCommand => C(0, indent);
const conditionalBranch = (params: unknown[], withElse = false): RmCommand[] => [
  C(111, 0, params), C(121, 1, [1, 1, 0]), END(1),
  ...(withElse ? [C(411, 0), C(121, 1, [2, 2, 0]), END(1)] : []),
  C(412, 0),
];

const NO_CONDS: RmPageConditions = {
  actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: "A", selfSwitchValid: false,
  switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0,
};

function rmPage(list: RmCommand[], extra: Partial<RmEventPage> = {}): RmEventPage {
  return {
    conditions: NO_CONDS,
    directionFix: false,
    image: { tileId: 0, characterName: "", characterIndex: 0, direction: 2, pattern: 1 },
    list: [...list, END(0)],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0 }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: 0,
    stepAnime: false,
    through: false,
    trigger: 0,
    walkAnime: true,
    ...extra,
  };
}

function rmProject(): RmProject {
  const map1 = {
    events: [
      null,
      // ev001 uses two self switch letters; ev002 only one.
      { id: 1, name: "Two", note: "", x: 1, y: 1, pages: [rmPage([C(123, 0, ["A", 0])]), rmPage([C(123, 0, ["B", 0])], { conditions: { ...NO_CONDS, selfSwitchValid: true, selfSwitchCh: "A" } })] },
      { id: 2, name: "One", note: "", x: 2, y: 1, pages: [rmPage([C(123, 0, ["A", 0])])] },
    ],
  } as unknown as RmMap;
  const actor = (id: number, name: string) => ({
    id, name, nickname: "", characterName: "", characterIndex: 0, faceName: "", faceIndex: 0,
    classId: 1, initialLevel: 1, equips: [1, 1], traits: [], note: "",
  });
  const tilesets: RmProject["tilesets"] = [null];
  tilesets[7] = { id: 7, name: "Alternate", mode: 0, tilesetNames: [], flags: [], note: "" };
  return {
    root: "",
    flavor: "MV",
    system: {
      gameTitle: "T", currencyUnit: "G", partyMembers: [1, 2], startMapId: 1, startX: 0, startY: 0,
      switches: Array(20).fill(""), variables: Array(20).fill(""),
    },
    mapInfos: [null],
    maps: new Map([[1, map1]]),
    tilesets,
    commonEvents: [null, { id: 1, name: "Shared", trigger: 0, switchId: 0, list: [END(0)] }],
    items: [null, { id: 1, name: "Potion", description: "", iconIndex: 0, price: 0, itypeId: 1, note: "" }],
    weapons: [null, { id: 1, name: "Sword", description: "", iconIndex: 0, price: 0, etypeId: 1, traits: [], note: "" }],
    armors: [null, { id: 1, name: "Coat", description: "", iconIndex: 0, price: 0, etypeId: 4, traits: [], note: "" }],
    actors: [null, actor(1, "Harold"), actor(2, "Therese")],
    classes: [null, { id: 1, name: "Adventurer", learnings: [{ level: 1, skillId: 1 }], traits: [], note: "" }],
    skills: [null, { id: 1, name: "Attack", note: "" }],
    states: [null, { id: 1, name: "Knockout", note: "" }],
    enemies: [null],
    troops: [null, { id: 1, name: "Bats", members: [], pages: [] }],
    animations: [null],
  };
}

const RM = rmProject();
const MAPS = new Map([[1, "map001"], [3, "map003"], [7, "map007"], [9, "map009"], [12, "map012"]]);

type Owner = EventContext["owner"];
const PAGE_OWNER: Owner = {
  kind: "page", mapId: "map001", eventId: "ev002", page: 0, trigger: "action",
  eventIds: new Map([[1, "ev001"], [2, "ev002"]]),
};

function makeCtx(opts: {
  placeholders?: "visible" | "silent";
  owner?: Owner;
  balloon?: boolean;
  flavor?: "MV" | "MZ";
  party?: number[];
  sideView?: boolean;
  audioCalls?: string[];
} = {}): EventContext {
  let shop = 0;
  let animation = 0;
  const flavored = opts.flavor ? { ...RM, flavor: opts.flavor } : RM;
  const rm = opts.party || opts.sideView !== undefined
    ? {
        ...flavored,
        system: {
          ...flavored.system,
          ...(opts.party ? { partyMembers: opts.party } : {}),
          ...(opts.sideView !== undefined ? { optSideView: opts.sideView } : {}),
        },
      }
    : flavored;
  return {
    rm,
    battleDatabaseHash: "a".repeat(64),
    cov: new Coverage(),
    placeholders: opts.placeholders ?? "visible",
    maps: MAPS,
    owner: opts.owner ?? PAGE_OWNER,
    sprite: (img) => (img.characterName ? `rm-${img.characterName.toLowerCase()}-${img.characterIndex}` : null),
    picture: (name) => `pic-${name.toLowerCase()}`,
    parallax: (name) => name ? { image: `parallax-${name.toLowerCase()}`, zero: name.startsWith("!") } : null,
    animation: (n) => n === 1 ? { id: "anim001", disposition: "Native" } : null,
    animationFailure: (n) => n === 2 ? "animation 2 could not be cooked" : undefined,
    balloon: (n) => (opts.balloon === false ? null : `balloon${n}`),
    audio: (kind, name) => {
      opts.audioCalls?.push(`${kind}:${name}`);
      return audioId(kind, name);
    },
    nextShopId: () => `shop${++shop}`,
    nextAnimationId: () => `animation${++animation}`,
  };
}

const COMMAND_LIST = { type: "array", items: { $ref: "#/$defs/command" } };

function expectSchemaValid(value: unknown, sch: object = COMMAND_LIST): void {
  expect(validateSchema(schema, value, sch)).toEqual([]);
}

/** Convert, check schema validity and compilability, return output + coverage. */
function conv(list: RmCommand[], opts: Parameters<typeof makeCtx>[0] = {}): { cmds: Command[]; cov: Coverage } {
  const ctx = makeCtx(opts);
  const cmds = convertCommands([...list, END(0)], ctx);
  expectSchemaValid(cmds);
  compile(cmds);
  return { cmds, cov: ctx.cov };
}

function counts(cov: Coverage, section: Parameters<Coverage["list"]>[0], key: string): Record<Disposition, number> {
  const row = cov.list(section).find((r) => r.key === key);
  return row ? row.counts : { Native: 0, Degraded: 0, Placeholder: 0, Dropped: 0 };
}

function only(cov: Coverage, code: number): Disposition {
  const c = counts(cov, "command", String(code));
  const ds = (Object.keys(c) as Disposition[]).filter((d) => c[d] > 0);
  expect(ds.length).toBe(1);
  expect(c[ds[0]!]).toBe(1);
  return ds[0]!;
}

// --- running commands on the real interpreter ------------------------------------

function kitMap(commands: Command[]): MapDef {
  const ev: GameEvent = { id: "e", x: 10, y: 9, pages: [{ trigger: "action", commands }] };
  return { id: "m", name: "m", width: 20, height: 13, sheets: ["t"], ground: Array(260).fill("t.0"), events: [ev] };
}

function runKit(commands: Command[], init: { gold?: number; variables?: Record<string, number>; items?: Record<string, number>; steps?: number }): InterpState {
  const w = createWorld(kitMap(commands));
  let s = createInterpState(createSwitchState(init));
  const base = { confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false, playerCell: { x: 10, y: 10 }, prevCell: { x: 10, y: 10 }, facing: 2 as const };
  s = stepInterp(w, s, { ...base, confirmEdge: true });
  for (let i = 0; i < 3; i++) s = stepInterp(w, s, base);
  return s;
}

/** Walk an if-tree over variable conditions and collect the transfers. */
function transfersFor(cmds: Command[], vars: Record<string, number>): Command[] {
  const out: Command[] = [];
  const holds = (c: Condition): boolean => {
    if (c.kind !== "variable") throw new Error("unexpected condition");
    const v = vars[c.id] ?? 0;
    return c.op === "==" ? v === c.value : c.op === "<=" ? v <= c.value : c.op === ">=" ? v >= c.value : v !== c.value;
  };
  for (const c of cmds) {
    if (c.op === "if") out.push(...transfersFor(holds(c.if) ? c.then : c.else ?? [], vars));
    else if (c.op === "transfer") out.push(c);
  }
  return out;
}

/** Walk the same map-id search tree and collect selected vehicle moves. */
function vehicleLocationsFor(cmds: Command[], vars: Record<string, number>): Command[] {
  const out: Command[] = [];
  const holds = (c: Condition): boolean => {
    if (c.kind !== "variable") throw new Error("unexpected condition");
    const v = vars[c.id] ?? 0;
    return c.op === "==" ? v === c.value : c.op === "<=" ? v <= c.value : c.op === ">=" ? v >= c.value : v !== c.value;
  };
  for (const c of cmds) {
    if (c.op === "if") out.push(...vehicleLocationsFor(holds(c.if) ? c.then : c.else ?? [], vars));
    else if (c.op === "setVehicleLocation") out.push(c);
  }
  return out;
}

// --- tree parsing ---------------------------------------------------------------------

describe("tree parsing", () => {
  const nested: RmCommand[] = [
    C(112, 0),
    C(102, 1, [["A", "B"], -2, 0, 2, 0]),
    C(402, 1, [0, "A"]),
    C(111, 2, [0, 1, 0]),
    C(111, 3, [0, 2, 1]),
    C(121, 4, [3, 3, 0]),
    END(4),
    C(412, 3),
    END(3),
    C(411, 2),
    C(113, 3),
    END(3),
    C(412, 2),
    END(2),
    C(402, 1, [1, "B"]),
    END(2),
    C(403, 1, [6, null]),
    C(115, 2),
    END(2),
    C(404, 1),
    END(1),
    C(413, 0),
  ];

  test("nests by indent: ifs inside choices inside a loop", () => {
    const tree = parseTree([...nested, END(0)]);
    expect(tree.length).toBe(1);
    expect(tree[0]!.cmd.code).toBe(112);
    const choices = tree[0]!.body![0]!;
    expect(choices.cmd.code).toBe(102);
    expect(choices.branches!.map((b) => b.marker.code)).toEqual([402, 402, 403]);
    const branch = choices.branches![0]!.body[0]!;
    expect(branch.cmd.code).toBe(111);
    expect(branch.body![0]!.cmd.code).toBe(111);
    expect(branch.body![0]!.body![0]!.cmd.code).toBe(121);
    expect(branch.elseBody!.map((n) => n.cmd.code)).toEqual([113]);
  });

  test("converts the nested tree with a native loop and nested break", () => {
    const { cmds, cov } = conv(nested);
    expect(cmds).toEqual([
      {
        op: "loop",
        commands: [{
          op: "choices",
          prompt: "",
          options: [
            {
              text: "A",
              commands: [{
                op: "if",
                if: { kind: "switch", id: "s001" },
                then: [{ op: "if", if: { kind: "switch", id: "s002", value: false }, then: [{ op: "switch", id: "s003", value: true }] }],
                else: [{ op: "break" }],
              }],
            },
            { text: "B", commands: [] },
          ],
          cancel: { commands: [{ op: "exit" }] },
        }],
      },
    ]);
    expect(counts(cov, "command", "112")).toMatchObject({ Native: 1 });
    expect(counts(cov, "command", "113")).toMatchObject({ Native: 1 });
    expect(counts(cov, "command", "111")).toMatchObject({ Native: 2 });
    expect(counts(cov, "command", "102")).toMatchObject({ Native: 1 });
    expect(counts(cov, "command", "115")).toMatchObject({ Native: 1 });
    expect(counts(cov, "command", "121")).toMatchObject({ Native: 1 });
    // Markers and terminators are not counted.
    expect(cov.list("command").map((r) => r.key)).toEqual(["102", "111", "112", "113", "115", "121"]);
  });

  test("orphan markers and continuation lines are skipped", () => {
    const { cmds } = conv([C(401, 0, ["stray"]), C(412, 0), C(121, 0, [1, 1, 0])]);
    expect(cmds).toEqual([{ op: "switch", id: "s001", value: true }]);
  });
});

// --- loops ------------------------------------------------------------------------------

describe("loops", () => {
  const loopBody = [
    C(112, 0),
    C(230, 1, [60]),
    C(111, 1, [0, 1, 0]),
    C(113, 2),
    END(2),
    C(412, 1),
    END(1),
    C(413, 0),
  ];

  test("a loop that is a parallel page's whole list stays a native loop", () => {
    const ctx = makeCtx();
    const page = convertPage(rmPage([C(108, 0, ["note"]), ...loopBody], { trigger: 4 }), 0, ctx);
    expect(page.trigger).toBe("parallel");
    expect(page.commands).toEqual([{ op: "loop", commands: [
      { op: "wait", seconds: 1 },
      { op: "if", if: { kind: "switch", id: "s001" }, then: [{ op: "break" }] },
    ] }]);
    expect(counts(ctx.cov, "command", "112")).toMatchObject({ Native: 1, Degraded: 0 });
    expect(counts(ctx.cov, "command", "113")).toMatchObject({ Native: 1 });
    expect(counts(ctx.cov, "trigger", "parallel")).toMatchObject({ Native: 1 });
  });

  test("the same loop on an action page stays a native loop", () => {
    const ctx = makeCtx();
    const page = convertPage(rmPage(loopBody), 0, ctx);
    expect(page.commands).toEqual([{ op: "loop", commands: [
      { op: "wait", seconds: 1 },
      { op: "if", if: { kind: "switch", id: "s001" }, then: [{ op: "break" }] },
    ] }]);
    expect(counts(ctx.cov, "command", "112")).toMatchObject({ Native: 1 });
    expect(counts(ctx.cov, "command", "113")).toMatchObject({ Native: 1 });
  });

  test("a loop followed by other commands remains native", () => {
    const ctx = makeCtx();
    convertPage(rmPage([...loopBody, C(121, 0, [1, 1, 0])], { trigger: 3 }), 0, ctx);
    expect(counts(ctx.cov, "command", "112")).toMatchObject({ Native: 1 });
  });

  test("Break Loop outside a loop uses the kit's root break and is reported degraded", () => {
    const { cmds, cov } = conv([C(113, 0)]);
    expect(cmds).toEqual([{ op: "break" }]);
    expect(only(cov, 113)).toBe("Degraded");
  });

  test("an imported counting loop executes until break on the real interpreter", () => {
    const { cmds } = conv([
      C(112, 0),
      C(122, 1, [1, 1, 1, 0, 1]),
      C(111, 1, [1, 1, 0, 3, 1]),
      C(113, 2),
      END(2),
      C(412, 1),
      END(1),
      C(413, 0),
      C(121, 0, [1, 1, 0]),
    ]);
    const state = runKit(cmds, { variables: { v001: 0 } });
    expect(state.sw.variables.v001).toBe(3);
    expect(state.sw.switches.s001).toBe(true);
  });

  test("Label and Jump to Label map natively", () => {
    const { cmds, cov } = conv([C(118, 0, ["top"]), C(119, 0, ["top"])]);
    // The label carries its flat source index (ord) so the runtime resolves
    // the first label in MV source order even when branches are reordered.
    expect(cmds).toEqual([{ op: "label", name: "top", ord: 0 }, { op: "jumpLabel", name: "top" }]);
    expect(only(cov, 118)).toBe("Native");
    expect(only(cov, 119)).toBe("Native");
  });

  test("Select Item, access flags, Stop SE and Get Location Info map natively", () => {
    // MV parameter layouts: 104 [variableId, itypeId] (1 regular, 2 key,
    // 3 hidden A, 4 hidden B); 134/135 [0=disable, nonzero=enable]; 285
    // [variableId, infoType, locationType, x, y] (infoType 0 terrain, 1
    // event, 2-5 tile layers 1-4, else region; locationType 0 direct, else
    // the two coordinates are variable ids).
    const { cmds, cov } = conv([
      C(104, 0, [1, 1]),
      C(104, 0, [3, 2]),
      C(134, 0, [1]),
      C(135, 0, [0]),
      C(251, 0, []),
      C(285, 0, [2, 0, 0, 3, 4]),
      C(285, 0, [5, 1, 0, 9, 9]),
      C(285, 0, [6, 4, 0, 1, 1]),
      C(285, 0, [7, 6, 1, 8, 9]),
    ]);
    expect(cmds).toEqual([
      { op: "selectItem", variable: "v001", itemType: "regular" },
      { op: "selectItem", variable: "v003", itemType: "key" },
      { op: "saveAccess", enabled: true },
      { op: "menuAccess", enabled: false },
      { op: "stopSe" },
      { op: "locationInfo", variable: "v002", x: 3, y: 4, kind: "terrain" },
      { op: "locationInfo", variable: "v005", x: 9, y: 9, kind: "event" },
      { op: "locationInfo", variable: "v006", x: 1, y: 1, kind: "tile", layer: 2 },
      { op: "locationInfo", variable: "v007", x: { variable: "v008" }, y: { variable: "v009" }, kind: "region" },
    ]);
    for (const code of [104, 134, 135, 251, 285]) {
      // Every occurrence maps Native (104 and 285 appear more than once).
      expect(counts(cov, "command", String(code)).Native).toBeGreaterThan(0);
    }
  });
});

// --- text and escape codes ----------------------------------------------------------------

describe("messages", () => {
  test("escape codes", () => {
    const ctx = makeCtx();
    const out = convertMessage(
      ["\\N[1] has \\V[3] \\G, \\c[2]red\\C[0] \\I[5]!", "\\n[2] and \\P[1]/\\P[2] \\\\ \\{big\\} \\.\\|\\!\\>\\<\\^\\$ \\PX[4]\\PY[8]\\FS[20]x"],
      ctx,
    );
    expect(out).toEqual([
      "\\N[1] has \\V[3] \\G, \\c[2]red\\C[0] \\I[5]!",
      "\\n[2] and \\P[1]/\\P[2] \\\\ \\{big\\} \\.\\|\\!\\>\\<\\^\\$ \\PX[4]\\PY[8]\\FS[20]x",
    ]);
    const esc = (k: string) => counts(ctx.cov, "escape", k);
    expect(esc("\\N")).toMatchObject({ Native: 2 });
    expect(esc("\\V")).toMatchObject({ Native: 1 });
    expect(esc("\\G")).toMatchObject({ Native: 1 });
    expect(esc("\\C")).toMatchObject({ Native: 2 });
    expect(esc("\\I")).toMatchObject({ Degraded: 1 });
    expect(esc("\\P")).toMatchObject({ Degraded: 2 });
    expect(esc("\\\\")).toMatchObject({ Native: 1 });
    expect(esc("\\{")).toMatchObject({ Degraded: 1 });
    expect(esc("\\^")).toMatchObject({ Degraded: 1 });
    expect(esc("\\PX")).toMatchObject({ Degraded: 1 });
    expect(esc("\\PY")).toMatchObject({ Degraded: 1 });
    expect(esc("\\FS")).toMatchObject({ Degraded: 1 });
  });

  test("recognized and unknown escapes keep their exact source spelling", () => {
    const ctx = makeCtx();
    expect(convertMessage(["\\Gold \\Vx \\Np"], ctx)).toEqual(["\\Gold \\Vx \\Np"]);
    expect(counts(ctx.cov, "escape", "\\G")).toMatchObject({ Native: 1 });
    expect(counts(ctx.cov, "escape", "\\VX")).toMatchObject({ Degraded: 1 });
  });

  test("Show Text: lines, face, MZ speaker, wrapping", () => {
    let r = conv([C(101, 0, ["", 0, 0, 2]), C(401, 0, ["Hello \\N[1]."]), C(401, 0, ["Bye."])]);
    expect(r.cmds).toEqual([{ op: "text", lines: ["Hello \\N[1].", "Bye."] }]);
    expect(only(r.cov, 101)).toBe("Native");

    r = conv([C(101, 0, ["Actor1", 0, 0, 2, "Reid"]), C(401, 0, ["Hi."])]);
    expect(r.cmds).toEqual([{ op: "text", lines: ["Reid: Hi."] }]);
    expect(only(r.cov, 101)).toBe("Degraded");

    const long = "word ".repeat(30).trim();
    r = conv([C(101, 0, ["", 0, 0, 2]), ...[1, 2, 3, 4].map(() => C(401, 0, [long]))]);
    expect(r.cmds.length).toBeGreaterThan(1);
    for (const c of r.cmds) expect(c.op).toBe("text");
    expect(only(r.cov, 101)).toBe("Degraded");
  });

  test("wrapping and choice truncation never split a runtime text escape", () => {
    expect(wrap([`${"x".repeat(49)}{v:v003}tail`], 52)).toEqual(["x".repeat(49), "{v:v003}tail"]);
    const label = `${"x".repeat(61)}\\V[3]tail`;
    const r = conv([
      C(102, 0, [[label, "No"], -1, 0, 2, 0]),
      C(402, 0, [0, label]), END(1),
      C(402, 0, [1, "No"]), END(1),
      C(404, 0),
    ]);
    expect(r.cmds[0]).toMatchObject({
      op: "choices",
      options: [{ text: "x".repeat(61), commands: [] }, { text: "No", commands: [] }],
    });
    expect(only(r.cov, 102)).toBe("Degraded");
  });

  test("Show Text before Show Choices folds into the prompt", () => {
    const choices = [C(102, 0, [["Yes", "No"], -1, 0, 2, 0]), C(402, 0, [0, "Yes"]), END(1), C(402, 0, [1, "No"]), END(1), C(404, 0)];
    let r = conv([C(101, 0, ["", 0, 0, 2]), C(401, 0, ["Buy it?"]), ...choices]);
    expect(r.cmds).toEqual([{
      op: "choices", prompt: "Buy it?", options: [{ text: "Yes", commands: [] }, { text: "No", commands: [] }],
    }]);
    expect(only(r.cov, 101)).toBe("Native");

    r = conv([C(101, 0, ["", 0, 0, 2]), C(401, 0, ["It costs 10."]), C(401, 0, ["Buy it?"]), ...choices]);
    expect(r.cmds[0]).toEqual({ op: "text", lines: ["It costs 10."] });
    expect(r.cmds[1]).toMatchObject({ op: "choices", prompt: "Buy it?" });
    expect(only(r.cov, 101)).toBe("Degraded");
  });

  test.each([
    ["window (default) is omitted", 0, {}],
    ["dim", 1, { background: "dim" }],
    ["transparent", 2, { background: "transparent" }],
  ] as [string, number, TextBoxLayout][])("Show Text background %s", (_name, background, layout) => {
    const r = conv([C(101, 0, ["", 0, background, 2]), C(401, 0, ["Hi."])]);
    expect(r.cmds).toEqual([{ op: "text", lines: ["Hi."], ...layout }]);
    expect(only(r.cov, 101)).toBe("Native");
  });

  test.each([
    ["top", 0, { position: "top" }],
    ["middle", 1, { position: "center" }],
    ["bottom (default) is omitted", 2, {}],
  ] as [string, number, TextBoxLayout][])("Show Text position %s", (_name, position, layout) => {
    const r = conv([C(101, 0, ["", 0, 0, position]), C(401, 0, ["Hi."])]);
    expect(r.cmds).toEqual([{ op: "text", lines: ["Hi."], ...layout }]);
    expect(only(r.cov, 101)).toBe("Native");
  });

  test("Show Text with absent layout parameters emits the plain text command", () => {
    const r = conv([C(101, 0, [""]), C(401, 0, ["Hi."])]);
    expect(r.cmds).toEqual([{ op: "text", lines: ["Hi."] }]);
    expect(only(r.cov, 101)).toBe("Native");
  });

  test("Show Text with a non-standard background or position shows the default box", () => {
    let r = conv([C(101, 0, ["", 0, 3, 2]), C(401, 0, ["Hi."])]);
    expect(r.cmds).toEqual([{ op: "text", lines: ["Hi."] }]);
    expect(only(r.cov, 101)).toBe("Degraded");
    r = conv([C(101, 0, ["", 0, 1, "0"]), C(401, 0, ["Hi."])]);
    expect(r.cmds).toEqual([{ op: "text", lines: ["Hi."], background: "dim" }]);
    expect(only(r.cov, 101)).toBe("Degraded");
  });

  test("every page of a split Show Text carries the layout", () => {
    const long = "word ".repeat(30).trim();
    const r = conv([C(101, 0, ["", 0, 2, 0]), ...[1, 2, 3, 4].map(() => C(401, 0, [long]))]);
    expect(r.cmds.length).toBeGreaterThan(1);
    for (const c of r.cmds) expect(c).toMatchObject({ op: "text", position: "top", background: "transparent" });
  });

  test("Show Text before Show Choices: the layout goes on the text pages, not the choices", () => {
    const choices = [C(102, 0, [["Yes", "No"], -1, 0, 2, 0]), C(402, 0, [0, "Yes"]), END(1), C(402, 0, [1, "No"]), END(1), C(404, 0)];
    let r = conv([C(101, 0, ["", 0, 1, 1]), C(401, 0, ["It costs 10."]), C(401, 0, ["Buy it?"]), ...choices]);
    expect(r.cmds[0]).toEqual({ op: "text", lines: ["It costs 10."], position: "center", background: "dim" });
    expect(r.cmds[1]).toEqual({
      op: "choices", prompt: "Buy it?", options: [{ text: "Yes", commands: [] }, { text: "No", commands: [] }],
    });

    // A single-option list becomes a message showing the prompt: it keeps the layout.
    const single = [C(102, 0, [["OK"], -1, 0, 2, 0]), C(402, 0, [0, "OK"]), END(1), C(404, 0)];
    r = conv([C(101, 0, ["", 0, 1, 0]), C(401, 0, ["Ready?"]), ...single]);
    expect(r.cmds).toEqual([{ op: "text", lines: ["Ready?", "OK"], position: "top", background: "dim" }]);
  });

  test("Show Scrolling Text preserves rows, speed and fast-forward policy", () => {
    let r = conv([C(105, 0, [3, false]), ...["a", "", "c", "d", "e"].map((t) => C(405, 0, [t]))]);
    expect(r.cmds).toEqual([{ op: "scrollText", lines: ["a", "", "c", "d", "e"], speed: 3 }]);
    expect(only(r.cov, 105)).toBe("Native");

    r = conv([C(105, 0, [8, true]), C(405, 0, ["No skipping"])]);
    expect(r.cmds).toEqual([{ op: "scrollText", lines: ["No skipping"], speed: 8, noFastForward: true }]);
    expect(only(r.cov, 105)).toBe("Native");
  });
});

// --- choices --------------------------------------------------------------------------------

describe("choices cancel types", () => {
  const list = (cancelType: number, withCancel: boolean): RmCommand[] => [
    C(102, 0, [["A", "B"], cancelType, 0, 2, 0]),
    C(402, 0, [0, "A"]), C(121, 1, [1, 1, 0]), END(1),
    C(402, 0, [1, "B"]), C(121, 1, [2, 2, 0]), END(1),
    ...(withCancel ? [C(403, 0, [6, null]), C(121, 1, [3, 3, 0]), END(1)] : []),
    C(404, 0),
  ];
  const optA = { text: "A", commands: [{ op: "switch", id: "s001", value: true }] };
  const optB = { text: "B", commands: [{ op: "switch", id: "s002", value: true }] };

  test.each([
    ["-2 runs the cancel branch", -2, true, { commands: [{ op: "switch", id: "s003", value: true }] }],
    ["-1 disallows cancel", -1, false, undefined],
    ["1 runs option B's branch", 1, false, { commands: [{ op: "switch", id: "s002", value: true }] }],
    ["beyond the list means branch", 5, true, { commands: [{ op: "switch", id: "s003", value: true }] }],
  ])("%s", (_name, cancelType, withCancel, cancel) => {
    const { cmds, cov } = conv(list(cancelType, withCancel));
    const expected: Record<string, unknown> = { op: "choices", prompt: "", options: [optA, optB] };
    if (cancel) expected.cancel = cancel;
    expect(cmds).toEqual([expected as Command]);
    expect(only(cov, 102)).toBe("Native");
    expect(counts(cov, "command", "121").Native).toBe(withCancel ? 3 : 2);
  });

  test("a single option the player must take becomes a message", () => {
    const { cmds, cov } = conv([C(102, 0, [["OK"], -1, 0, 2, 0]), C(402, 0, [0, "OK"]), C(121, 1, [1, 1, 0]), END(1), C(404, 0)]);
    expect(cmds).toEqual([{ op: "text", lines: ["OK"] }, { op: "switch", id: "s001", value: true }]);
    expect(only(cov, 102)).toBe("Degraded");
  });

  test("a single option with a cancel branch is padded", () => {
    const { cmds, cov } = conv([C(102, 0, [["OK"], -2, 0, 2, 0]), C(402, 0, [0, "OK"]), END(1), C(403, 0), C(115, 1), END(1), C(404, 0)]);
    expect(cmds).toEqual([{
      op: "choices", prompt: "",
      options: [{ text: "OK", commands: [] }, { text: "Cancel", commands: [{ op: "exit" }] }],
      cancel: { commands: [{ op: "exit" }] },
    }]);
    expect(only(cov, 102)).toBe("Degraded");
  });
});

// --- conditional branch ----------------------------------------------------------------------

describe("conditional branch", () => {
  const branch = conditionalBranch;
  const THEN: Command = { op: "switch", id: "s001", value: true };
  const ELSE: Command = { op: "switch", id: "s002", value: true };
  const tmp = "rmi-tmp1";
  // The dead-branch structure an unevaluable condition compiles to: the
  // Then is kept (its labels stay reachable) but skipped on fall-through,
  // and the Else is skipped when a jump lands in the Then. Mirrors the
  // importer's deadBranch for the first unevaluable condition (seq 0).
  const dead = (then: Command[], els: Command[] | undefined, placeholder?: Command[]): Command[] => {
    const out: Command[] = [...(placeholder ?? [])];
    if (then.length === 0) {
      if (els) out.push(...els);
      return out;
    }
    out.push({ op: "jumpLabel", name: "__dead_else_0" });
    out.push(...then);
    if (els && els.length > 0) {
      out.push({ op: "jumpLabel", name: "__dead_end_0" });
      out.push({ op: "label", name: "__dead_else_0" });
      out.push(...els);
      out.push({ op: "label", name: "__dead_end_0" });
    } else {
      out.push({ op: "label", name: "__dead_else_0" });
    }
    return out;
  };

  test.each<[string, unknown[], Command[], string, Disposition]>([
    ["switch ON", [0, 5, 0], [{ op: "if", if: { kind: "switch", id: "s005" }, then: [THEN], else: [ELSE] }], "switch", "Native"],
    ["switch OFF", [0, 5, 1], [{ op: "if", if: { kind: "switch", id: "s005", value: false }, then: [THEN], else: [ELSE] }], "switch", "Native"],
    ["variable == c", [1, 2, 0, 7, 0], [{ op: "if", if: { kind: "variable", id: "v002", op: "==", value: 7 }, then: [THEN], else: [ELSE] }], "variable", "Native"],
    ["variable > c", [1, 2, 0, 7, 3], [{ op: "if", if: { kind: "variable", id: "v002", op: ">=", value: 8 }, then: [THEN], else: [ELSE] }], "variable", "Native"],
    ["variable < c", [1, 2, 0, 7, 4], [{ op: "if", if: { kind: "variable", id: "v002", op: "<=", value: 6 }, then: [THEN], else: [ELSE] }], "variable", "Native"],
    ["variable != c", [1, 2, 0, 7, 5], [{ op: "if", if: { kind: "variable", id: "v002", op: "!=", value: 7 }, then: [THEN], else: [ELSE] }], "variable", "Native"],
    ["variable > variable", [1, 2, 1, 3, 3], [
      { op: "variable", id: tmp, set: { op: "copy", from: "v002" } },
      { op: "variable", id: tmp, set: { op: "sub", from: "v003" } },
      { op: "if", if: { kind: "variable", id: tmp, op: ">=", value: 1 }, then: [THEN], else: [ELSE] },
    ], "variable", "Native"],
    ["self switch", [2, "B", 0], [{ op: "if", if: { kind: "selfSwitch", key: "B" }, then: [THEN], else: [ELSE] }], "selfSwitch", "Native"],
    ["timer >=", [3, 60, 0], [{ op: "if", if: { kind: "timer", op: ">=", seconds: 60 }, then: [THEN], else: [ELSE] }], "timer", "Native"],
    ["timer <=", [3, 30, 1], [{ op: "if", if: { kind: "timer", op: "<=", seconds: 30 }, then: [THEN], else: [ELSE] }], "timer", "Native"],
    ["actor in party", [4, 2, 0], [{ op: "if", if: { kind: "switch", id: "party-actor002" }, then: [THEN], else: [ELSE] }], "actor", "Native"],
    ["actor name", [4, 2, 1, "Therese"], [{ op: "if", if: { kind: "actor", actor: "actor002", test: "name", value: "Therese" }, then: [THEN], else: [ELSE] }], "actor", "Native"],
    ["actor class", [4, 2, 2, 1], [{ op: "if", if: { kind: "actor", actor: "actor002", test: "class", value: "class001" }, then: [THEN], else: [ELSE] }], "actor", "Degraded"],
    ["actor skill", [4, 2, 3, 1], [{ op: "if", if: { kind: "actor", actor: "actor002", test: "skill", value: "skill001" }, then: [THEN], else: [ELSE] }], "actor", "Degraded"],
    ["actor weapon", [4, 2, 4, 1], [{ op: "if", if: { kind: "actor", actor: "actor002", test: "weapon", value: "weapon001" }, then: [THEN], else: [ELSE] }], "actor", "Degraded"],
    ["actor armor", [4, 2, 5, 1], [{ op: "if", if: { kind: "actor", actor: "actor002", test: "armor", value: "armor001" }, then: [THEN], else: [ELSE] }], "actor", "Degraded"],
    ["actor state", [4, 2, 6, 1], [{ op: "if", if: { kind: "actor", actor: "actor002", test: "state", value: "state001" }, then: [THEN], else: [ELSE] }], "actor", "Degraded"],
    ["enemy", [5, 0, 0], dead([THEN], [ELSE]), "enemy", "Degraded"],
    ["player facing", [6, -1, 8], [{ op: "if", if: { kind: "facing", dir: "up" }, then: [THEN], else: [ELSE] }], "character", "Native"],
    ["event facing", [6, 1, 8], dead([THEN], [ELSE]), "character", "Degraded"],
    ["gold >=", [7, 100, 0], [{ op: "if", if: { kind: "gold", amount: 100 }, then: [THEN], else: [ELSE] }], "gold", "Native"],
    ["gold <=", [7, 100, 1], [{ op: "if", if: { kind: "gold", amount: 101 }, then: [ELSE], else: [THEN] }], "gold", "Native"],
    ["gold <", [7, 100, 2], [{ op: "if", if: { kind: "gold", amount: 100 }, then: [ELSE], else: [THEN] }], "gold", "Native"],
    ["item", [8, 4], [{ op: "if", if: { kind: "item", id: "item004", count: 1 }, then: [THEN], else: [ELSE] }], "item", "Native"],
    ["weapon", [9, 4, false], [{ op: "if", if: { kind: "item", id: "weapon004", count: 1 }, then: [THEN], else: [ELSE] }], "weapon", "Native"],
    ["armor incl. equipped", [10, 4, true], [{ op: "if", if: { kind: "item", id: "armor004", count: 1 }, then: [THEN], else: [ELSE] }], "armor", "Degraded"],
    ["button", [11, "ok"], dead([THEN], [ELSE]), "button", "Degraded"],
    ["vehicle", [13, 0], [{ op: "if", if: { kind: "vehicle", id: "boat" }, then: [THEN], else: [ELSE] }], "vehicle", "Native"],
  ])("%s", (_name, params, expected, key, d) => {
    const { cmds, cov } = conv(branch(params, true));
    expect(cmds).toEqual(expected);
    expect(only(cov, 111)).toBe(d);
    expect(counts(cov, "condition", key)[d]).toBe(1);
    // Commands in an unevaluable then-branch are still counted.
    expect(counts(cov, "command", "121").Native).toBe(2);
  });

  test("gold <= without else swaps into an empty then", () => {
    const { cmds } = conv(branch([7, 50, 1]));
    expect(cmds).toEqual([{ op: "if", if: { kind: "gold", amount: 51 }, then: [], else: [THEN] }]);
  });

  test("missing actor database references remain an explicit false branch", () => {
    for (const params of [[4, 99, 1, "Nobody"], [4, 1, 2, 99], [4, 1, 3, 99], [4, 1, 4, 99], [4, 1, 5, 99], [4, 1, 6, 99]]) {
      const { cmds, cov } = conv(branch(params, true));
      expect(cmds).toEqual(dead([THEN], [ELSE]));
      expect(only(cov, 111)).toBe("Dropped");
      expect(counts(cov, "condition", "actor").Dropped).toBe(1);
    }
  });

  test("script condition: placeholder in both modes", () => {
    const placeholder = { op: "text", lines: ["[Script condition not ported:", "$gameParty.size() > 2]"] } as Command;
    let r = conv(branch([12, "$gameParty.size() > 2"], true));
    expect(r.cmds).toEqual(dead([THEN], [ELSE], [placeholder]));
    expect(only(r.cov, 111)).toBe("Placeholder");
    r = conv(branch([12, "x"], true), { placeholders: "silent" });
    expect(r.cmds).toEqual(dead([THEN], [ELSE]));
    expect(only(r.cov, 111)).toBe("Placeholder");
  });

  test.each([
    ["$gameParty.steps() >= 12", { kind: "steps", op: ">=", value: 12 }],
    ["($gameParty.steps() < 5)", { kind: "steps", op: "<=", value: 4 }],
    ["20 > $gameParty.steps()", { kind: "steps", op: "<=", value: 19 }],
    ["$gameParty . steps ( ) !== 7", { kind: "steps", op: "!=", value: 7 }],
  ] as const)("Steps script condition maps natively: %s", (source, condition) => {
    const { cmds, cov } = conv(branch([12, source], true));
    expect(cmds).toEqual([{ op: "if", if: condition, then: [THEN], else: [ELSE] }]);
    expect(only(cov, 111)).toBe("Native");
    expect(counts(cov, "condition", "script")).toMatchObject({ Native: 1 });
  });

  test("comparison lowerings agree with MV on the interpreter", () => {
    const ops = [0, 1, 2, 3, 4, 5];
    const mv = (a: number, b: number, op: number): boolean =>
      [a === b, a >= b, a <= b, a > b, a < b, a !== b][op]!;
    for (const op of ops) {
      for (const [a, b] of [[3, 5], [5, 5], [7, 5], [-2, -9]] as const) {
        for (const byVar of [false, true]) {
          const { cmds } = conv(branch(byVar ? [1, 2, 1, 3, op] : [1, 2, 0, b, op]));
          const s = runKit(cmds, { variables: { v002: a, v003: b } });
          expect([op, a, b, byVar, s.sw.switches["s001"] === true]).toEqual([op, a, b, byVar, mv(a, b, op)]);
        }
      }
    }
    for (const op of [0, 1, 2]) {
      for (const gold of [99, 100, 101]) {
        const { cmds } = conv(branch([7, 100, op], true));
        const s = runKit(cmds, { gold });
        const want = [gold >= 100, gold <= 100, gold < 100][op];
        expect([op, gold, s.sw.switches["s001"] === true]).toEqual([op, gold, want]);
        expect([op, gold, s.sw.switches["s002"] === true]).toEqual([op, gold, !want]);
      }
    }
  });
});

// --- variables, gold, items -----------------------------------------------------------------------

describe("control variables", () => {
  test.each<[string, unknown[], Command[]]>([
    ["set range", [1, 2, 0, 0, 5], [
      { op: "variable", id: "v001", set: { op: "set", value: 5 } },
      { op: "variable", id: "v002", set: { op: "set", value: 5 } },
    ]],
    ["mul by constant via scratch", [4, 4, 3, 0, 3], [
      { op: "variable", id: "rmi-tmp1", set: { op: "set", value: 3 } },
      { op: "variable", id: "v004", set: { op: "mul", from: "rmi-tmp1" } },
    ]],
    ["add variable", [4, 4, 1, 1, 9], [{ op: "variable", id: "v004", set: { op: "add", from: "v009" } }]],
    ["source inside the range is read once", [1, 3, 1, 1, 2], [
      { op: "variable", id: "rmi-tmp2", set: { op: "copy", from: "v002" } },
      { op: "variable", id: "v001", set: { op: "add", from: "rmi-tmp2" } },
      { op: "variable", id: "v002", set: { op: "add", from: "rmi-tmp2" } },
      { op: "variable", id: "v003", set: { op: "add", from: "rmi-tmp2" } },
    ]],
    ["random set", [4, 4, 0, 2, 1, 6], [{ op: "variable", id: "v004", set: { op: "random", min: 1, max: 6 } }]],
    ["random add via scratch", [4, 4, 1, 2, 1, 6], [
      { op: "variable", id: "rmi-tmp1", set: { op: "random", min: 1, max: 6 } },
      { op: "variable", id: "v004", set: { op: "add", from: "rmi-tmp1" } },
    ]],
    ["map id on a page is a constant", [4, 4, 0, 3, 7, 0, 0], [{ op: "variable", id: "v004", set: { op: "set", value: 1 } }]],
  ])("%s", (_name, params, expected) => {
    const { cmds, cov } = conv([C(122, 0, params)]);
    expect(cmds).toEqual(expected);
    expect(only(cov, 122)).toBe("Native");
  });

  test("constant arithmetic matches MV on the interpreter", () => {
    for (const [op, want] of [[3, 21], [4, 2], [5, 1]] as const) {
      const { cmds } = conv([C(122, 0, [4, 4, op, 0, 3])]);
      expect(runKit(cmds, { variables: { v004: 7 } }).sw.variables["v004"]).toBe(want);
    }
  });

  test("item count and gold game data read exactly", () => {
    const item = conv([C(122, 0, [4, 4, 0, 3, 0, 5, 0])]);
    expect(only(item.cov, 122)).toBe("Native");
    for (const n of [0, 1, 37, 64, 99]) {
      expect(runKit(item.cmds, { items: { item005: n } }).sw.variables["v004"]).toBe(n);
    }
    const gold = conv([C(122, 0, [4, 4, 1, 3, 7, 2, 0])]);
    expect(only(gold.cov, 122)).toBe("Native");
    for (const g of [0, 1, 12345, 99999999]) {
      const s = runKit(gold.cmds, { gold: g, variables: { v004: 10 } });
      expect(s.sw.variables["v004"]).toBe(10 + g);
      expect(s.sw.gold).toBe(g);
    }
  });

  test("timer game data reads into scratch before applying the operation", () => {
    const { cmds, cov } = conv([C(122, 0, [4, 4, 1, 3, 7, 5, 0])]);
    expect(cmds).toEqual([
      { op: "timer", action: "read", variable: "rmi-tmp1" },
      { op: "variable", id: "v004", set: { op: "add", from: "rmi-tmp1" } },
    ]);
    expect(only(cov, 122)).toBe("Native");
  });

  test("Steps game data uses the native counter operand for set and arithmetic", () => {
    const set = conv([C(122, 0, [4, 5, 0, 3, 7, 3, 0])]);
    expect(set.cmds).toEqual([
      { op: "variable", id: "v004", set: { op: "steps" } },
      { op: "variable", id: "v005", set: { op: "steps" } },
    ]);
    expect(only(set.cov, 122)).toBe("Native");
    expect(runKit(set.cmds, { steps: 37 }).sw.variables).toMatchObject({ v004: 37, v005: 37 });

    const add = conv([C(122, 0, [4, 5, 1, 3, 7, 3, 0])]);
    expect(add.cmds).toEqual([
      { op: "variable", id: "rmi-tmp1", set: { op: "steps" } },
      { op: "variable", id: "v004", set: { op: "add", from: "rmi-tmp1" } },
      { op: "variable", id: "v005", set: { op: "add", from: "rmi-tmp1" } },
    ]);
    expect(runKit(add.cmds, { steps: 37, variables: { v004: 1, v005: 2 } }).sw.variables)
      .toMatchObject({ v004: 38, v005: 39 });
  });

  test("unsupported game data is dropped; script is a placeholder", () => {
    let r = conv([C(122, 0, [4, 4, 0, 3, 5, -1, 0])]);
    expect(r.cmds).toEqual([]);
    expect(only(r.cov, 122)).toBe("Dropped");
    r = conv([C(122, 0, [4, 4, 0, 4, "Math.random()"])]);
    expect(r.cmds).toEqual([{ op: "text", lines: ["[Script not ported:", "Math.random()]"] }]);
    expect(only(r.cov, 122)).toBe("Placeholder");
  });
});

describe("switches, self switches, party", () => {
  test("number input clamps digits and timer commands retain their parameters", () => {
    const { cmds, cov } = conv([
      C(103, 0, [7, 12]), C(103, 0, [8, 0]),
      C(124, 0, [0, 90]), C(124, 0, [1, 0]),
    ]);
    expect(cmds).toEqual([
      { op: "inputNumber", variable: "v007", digits: 8 },
      { op: "inputNumber", variable: "v008", digits: 1 },
      { op: "timer", action: "start", seconds: 90 },
      { op: "timer", action: "stop" },
    ]);
    expect(counts(cov, "command", "103")).toMatchObject({ Native: 2 });
    expect(counts(cov, "command", "124")).toMatchObject({ Native: 2 });
  });

  test("switch range and party member", () => {
    const r = conv([C(121, 0, [1, 2, 1]), C(129, 0, [3, 0, false]), C(129, 0, [3, 1, false])]);
    expect(r.cmds).toEqual([
      { op: "switch", id: "s001", value: false },
      { op: "switch", id: "s002", value: false },
      { op: "switch", id: "party-actor003", value: true },
      { op: "switch", id: "party-actor003", value: false },
    ]);
  });

  test("self switch is degraded on an event that uses several letters", () => {
    let r = conv([C(123, 0, ["A", 0])]);
    expect(r.cmds).toEqual([{ op: "selfSwitch", key: "A", value: true }]);
    expect(only(r.cov, 123)).toBe("Native");
    r = conv([C(123, 0, ["B", 1])], { owner: { ...PAGE_OWNER, eventId: "ev001" } as Owner });
    expect(r.cmds).toEqual([{ op: "selfSwitch", key: "B", value: false }]);
    expect(only(r.cov, 123)).toBe("Degraded");
  });
});

describe("gold and items", () => {
  test("constant changes; guarded losses are native", () => {
    let r = conv([C(125, 0, [0, 0, 100]), C(126, 0, [2, 0, 0, 150]), C(127, 0, [3, 1, 0, 1, true])]);
    expect(r.cmds).toEqual([
      { op: "gold", set: "add", amount: 100 },
      { op: "item", item: "item002", set: "add", count: 99 },
      { op: "item", item: "item002", set: "add", count: 51 },
      { op: "item", item: "weapon003", set: "sub", count: 1 },
    ]);
    expect(only(r.cov, 125)).toBe("Native");
    expect(only(r.cov, 127)).toBe("Degraded");

    r = conv([C(125, 0, [1, 0, 50])]);
    expect(only(r.cov, 125)).toBe("Degraded");
    r = conv([C(111, 0, [7, 50, 0]), C(125, 1, [1, 0, 50]), END(1), C(412, 0)]);
    expect(only(r.cov, 125)).toBe("Native");
    r = conv([C(111, 0, [8, 4]), C(126, 1, [4, 1, 0, 1]), END(1), C(412, 0)]);
    expect(only(r.cov, 126)).toBe("Native");
  });

  test("variable amounts lower to binary if-chains that match MV", () => {
    for (const [op, v, want] of [[0, 1234, 1334], [1, 34, 66], [0, -30, 70], [1, -5, 105]] as const) {
      const { cmds, cov } = conv([C(125, 0, [op, 1, 6])]);
      expect(only(cov, 125)).toBe("Degraded");
      expect(runKit(cmds, { gold: 100, variables: { v006: v } }).sw.gold).toBe(want);
    }
    for (const [op, v, want] of [[0, 99, 104], [1, 3, 2], [0, -2, 3]] as const) {
      const { cmds } = conv([C(126, 0, [7, op, 1, 6])]);
      expect(runKit(cmds, { items: { item007: 5 }, variables: { v006: v } }).sw.items["item007"]).toBe(want);
    }
  });
});

// --- map, characters, routes ---------------------------------------------------------------------

describe("transfer", () => {
  test("direct transfer with fades", () => {
    let r = conv([C(201, 0, [0, 3, 4, 5, 8, 0])]);
    expect(r.cmds).toEqual([{ op: "transfer", map: "map003", x: 4, y: 5, dir: "up", fade: 0.8 }]);
    expect(only(r.cov, 201)).toBe("Native");
    r = conv([C(201, 0, [0, 3, 4, 5, 0, 2])]);
    expect(r.cmds).toEqual([{ op: "transfer", map: "map003", x: 4, y: 5 }]);
    r = conv([C(201, 0, [0, 3, 4, 5, 0, 1])]);
    expect(only(r.cov, 201)).toBe("Degraded");
    r = conv([C(201, 0, [0, 99, 4, 5, 0, 0])]);
    expect(r.cmds).toEqual([]);
    expect(only(r.cov, 201)).toBe("Dropped");
  });

  test("transfer by variable is a search tree over imported maps", () => {
    const { cmds, cov } = conv([C(201, 0, [1, 10, 11, 12, 4, 0])]);
    expect(only(cov, 201)).toBe("Native");
    for (const [rm, kit] of MAPS) {
      expect(transfersFor(cmds, { v010: rm })).toEqual([{
        op: "transfer", map: kit, x: { variable: "v011" }, y: { variable: "v012" }, dir: "left", fade: 0.8,
      }]);
    }
    expect(transfersFor(cmds, { v010: 5 })).toEqual([]);
  });

  test("vehicle location, boarding, followers and image commands are native", () => {
    const { cmds, cov } = conv([
      C(202, 0, [2, 0, 3, 4, 5]),
      C(140, 0, [0, { name: "Ship Theme", volume: 77, pitch: 112, pan: 0 }]),
      C(206, 0),
      C(216, 0, [0]), C(216, 0, [1]), C(217, 0),
      C(323, 0, [1, "Vehicle", 2]),
    ]);
    expect(cmds).toEqual([
      { op: "setVehicleLocation", id: "airship", map: "map003", x: 4, y: 5 },
      { op: "setVehicleBgm", id: "boat", bgm: { id: "bgm-ship-theme", volume: 77, pitch: 112 } },
      { op: "vehicle", action: "toggle" },
      { op: "followers", visible: true },
      { op: "followers", visible: false },
      { op: "gatherFollowers" },
      { op: "setVehicleImage", id: "ship", sprite: "rm-vehicle-2" },
    ]);
    for (const code of [140, 202, 206, 216, 217, 323]) expect(counts(cov, "command", String(code)).Native).toBeGreaterThan(0);
  });

  test("vehicle BGM imports silence, clamps parameters, preserves pan and rejects unknown vehicles", () => {
    let converted = conv([C(140, 0, [1, { name: "", volume: 90, pitch: 100, pan: 0 }])]);
    expect(converted.cmds).toEqual([{ op: "setVehicleBgm", id: "ship", bgm: null }]);
    expect(only(converted.cov, 140)).toBe("Native");

    converted = conv([C(140, 0, [2, { name: "Sky", volume: 999, pitch: -10, pan: 25 }])]);
    expect(converted.cmds).toEqual([{
      op: "setVehicleBgm", id: "airship", bgm: { id: "bgm-sky", volume: 100, pitch: 50, pan: 25 },
    }]);
    expect(only(converted.cov, 140)).toBe("Native");

    converted = conv([C(140, 0, [9, { name: "Bad", volume: 90, pitch: 100, pan: 0 }])]);
    expect(converted.cmds).toEqual([]);
    expect(only(converted.cov, 140)).toBe("Dropped");
  });

  test("vehicle location by variables translates numeric RM map ids", () => {
    const { cmds, cov } = conv([C(202, 0, [0, 1, 10, 11, 12])]);
    expect(only(cov, 202)).toBe("Native");
    for (const [rm, kit] of MAPS) {
      expect(vehicleLocationsFor(cmds, { v010: rm })).toEqual([{
        op: "setVehicleLocation", id: "boat", map: kit,
        x: { variable: "v011" }, y: { variable: "v012" },
      }]);
    }
    expect(vehicleLocationsFor(cmds, { v010: 5 })).toEqual([]);
  });

  test("invalid vehicle operands are dropped", () => {
    let r = conv([C(202, 0, [9, 0, 3, 4, 5])]);
    expect(r.cmds).toEqual([]);
    expect(only(r.cov, 202)).toBe("Dropped");
    r = conv([C(202, 0, [0, 0, 99, 4, 5])]);
    expect(r.cmds).toEqual([]);
    expect(only(r.cov, 202)).toBe("Dropped");
    r = conv([C(323, 0, [0, "", 0])]);
    expect(r.cmds).toEqual([]);
    expect(only(r.cov, 323)).toBe("Dropped");
    r = conv([C(323, 0, ["not-a-vehicle", "Vehicle", 0])]);
    expect(r.cmds).toEqual([]);
    expect(only(r.cov, 323)).toBe("Dropped");
  });

  test("scroll map retains direction, distance, speed and wait", () => {
    const { cmds, cov } = conv([C(204, 0, [8, 6, 5, true])]);
    expect(cmds).toEqual([{ op: "scrollMap", direction: "up", distance: 6, speed: 5, wait: true }]);
    expect(only(cov, 204)).toBe("Native");
  });
});

describe("characters and routes", () => {
  test("set event location", () => {
    let r = conv([C(203, 0, [2, 0, 4, 6, 6])]);
    expect(r.cmds).toEqual([{ op: "place", target: { event: "ev002" }, x: 4, y: 6, dir: "right" }]);
    expect(only(r.cov, 203)).toBe("Native");
    r = conv([C(203, 0, [0, 1, 4, 6, 0])]);
    expect(r.cmds).toEqual([]);
    expect(only(r.cov, 203)).toBe("Dropped");
  });

  test("move route steps", () => {
    const route = {
      list: [
        { code: 1 }, { code: 12 }, { code: 16 }, { code: 25 }, { code: 24 },
        { code: 15, parameters: [32] },
        { code: 29, parameters: [5] }, { code: 15, parameters: [8] },
        { code: 30, parameters: [4] }, { code: 35 }, { code: 38 },
        { code: 0 },
      ],
      repeat: false, skippable: true, wait: true,
    };
    const { cmds, cov } = conv([C(205, 0, [-1, route]), C(505, 0, [{ code: 1 }])]);
    expect(cmds).toEqual([{
      op: "moveRoute", target: "player", wait: true,
      route: {
        steps: [
          "moveDown", "stepForward", "faceDown", "turnTowardPlayer", "turnRandom", "wait", "wait",
          { control: { kind: "speed", value: 5 } }, "wait",
          { control: { kind: "frequency", value: 4 } }, { control: { kind: "directionFix", value: true } },
          { control: { kind: "through", value: false } },
        ],
        repeat: false, skippable: true,
      },
    }]);
    expect(only(cov, 205)).toBe("Native");
    expect(counts(cov, "route", "wait")).toMatchObject({ Native: 2 });
  });

  test("lossy route steps degrade the route", () => {
    const route = {
      list: [{ code: 5 }, { code: 9 }, { code: 10 }, { code: 14, parameters: [1, 0] }, { code: 15, parameters: [20] }, { code: 27, parameters: [1] }, { code: 0 }],
      repeat: true, skippable: false, wait: false,
    };
    const { cmds, cov } = conv([C(205, 0, [1, route])]);
    expect(cmds).toEqual([{
      op: "moveRoute", target: { event: "ev001" }, wait: false,
      route: { steps: ["moveDown", "moveLeft", "turnRandom", "stepForward", "turnTowardPlayer", "stepForward", "wait"], repeat: true, skippable: false },
    }]);
    expect(only(cov, 205)).toBe("Degraded");
    expect(counts(cov, "route", "moveLowerLeft").Degraded).toBe(1);
    expect(counts(cov, "route", "jump").Dropped).toBe(1);
    expect(counts(cov, "route", "switchOn").Dropped).toBe(1);
    expect(counts(cov, "route", "wait").Degraded).toBe(1);
  });

  test("route to a missing event is dropped", () => {
    const { cmds, cov } = conv([C(205, 0, [42, { list: [{ code: 1 }, { code: 0 }], repeat: false, skippable: false, wait: true }])]);
    expect(cmds).toEqual([]);
    expect(only(cov, 205)).toBe("Dropped");
  });

  test("convertMoveRoute", () => {
    const ctx = makeCtx();
    expect(convertMoveRoute({ list: [{ code: 4 }, { code: 15, parameters: [16] }, { code: 0 }], repeat: true, skippable: false, wait: false }, ctx))
      .toEqual({ steps: ["moveUp", "wait"], repeat: true, skippable: false });
  });

  test("transparency, animation, balloon, erase", () => {
    let r = conv([C(211, 0, [0]), C(211, 0, [1]), C(212, 0, [-1, 1, true]), C(212, 0, [0, 1, false]), C(213, 0, [0, 3, true]), C(214, 0)]);
    expect(r.cmds).toEqual([
      { op: "appearance", target: "player", visible: false },
      { op: "appearance", target: "player", visible: true },
      { op: "mapAnim", id: "animation1", anim: "anim001", target: "player", wait: true },
      { op: "mapAnim", id: "animation2", anim: "anim001", target: "this", wait: false },
      { op: "balloon", target: "this", icon: "balloon3", duration: 76 / 60, wait: true },
      { op: "erase" },
    ]);
    expect(counts(r.cov, "command", "212").Native).toBe(2);
    r = conv([C(212, 0, [0, 2, false])]);
    expect(r.cmds).toEqual([]);
    expect(only(r.cov, 212)).toBe("Dropped");
    r = conv([C(213, 0, [-1, 3, false])], { balloon: false });
    expect(r.cmds).toEqual([]);
    expect(only(r.cov, 213)).toBe("Dropped");
  });
});

// --- actor changes and battle settings ----------------------------------------------------------

describe("actor changes and battle settings", () => {
  test("actor selectors, numeric operands, and allowDeath keep their payload shape", () => {
    const { cmds, cov } = conv([
      C(311, 0, [0, 1, 1, 0, 25.5, true]),
      C(312, 0, [1, 4, 0, 1, 7]),
      C(326, 0, [0, 0, 0, 0, 12]),
    ]);
    expect(cmds).toEqual([
      {
        op: "ext", call: "rpgmaker.actorChange",
        args: {
          kind: "hp", target: { kind: "actor", id: 1 }, operation: "sub",
          operand: { kind: "constant", value: 25.5 }, allowDeath: true,
        },
      },
      {
        op: "ext", call: "rpgmaker.actorChange",
        args: {
          kind: "mp", target: { kind: "variable", id: "v004" }, operation: "add",
          operand: { kind: "variable", id: "v007" },
        },
      },
      {
        op: "ext", call: "rpgmaker.actorChange",
        args: {
          kind: "tp", target: { kind: "all" }, operation: "add",
          operand: { kind: "constant", value: 12 },
        },
      },
    ]);
    for (const code of [311, 312, 326]) expect(only(cov, code)).toBe("Native");
  });

  test("actor mutations preserve ids, flags, strings, and zero-based equipment slots", () => {
    const { cmds, cov } = conv([
      C(313, 0, [0, 1, 0, 1]),
      C(314, 0, [0, 1]),
      C(315, 0, [0, 1, 0, 0, 120, true]),
      C(316, 0, [0, 1, 1, 1, 8, true]),
      C(317, 0, [0, 1, 2, 0, 0, 3]),
      C(318, 0, [0, 1, 0, 1]),
      C(319, 0, [1, 4, 1]),
      C(321, 0, [1, 1, true]),
      C(322, 0, [1, "Hero", 3, "HeroFace", 5, "HeroBattler"]),
      C(324, 0, [1, "The Swift"]),
      C(325, 0, [1, "No line is trimmed."]),
    ]);
    expect(cmds.map((c) => c.op === "ext" ? c.args : null)).toEqual([
      { kind: "state", target: { kind: "actor", id: 1 }, operation: "add", stateId: 1 },
      { kind: "recoverAll", target: { kind: "actor", id: 1 } },
      { kind: "exp", target: { kind: "actor", id: 1 }, operation: "add", operand: { kind: "constant", value: 120 }, show: true },
      { kind: "level", target: { kind: "actor", id: 1 }, operation: "sub", operand: { kind: "variable", id: "v008" }, show: true },
      { kind: "parameter", target: { kind: "actor", id: 1 }, paramId: 2, operation: "add", operand: { kind: "constant", value: 3 } },
      { kind: "skill", target: { kind: "actor", id: 1 }, operation: "add", skillId: 1 },
      { kind: "equipment", actorId: 1, slotId: 3, itemId: 1 },
      { kind: "class", actorId: 1, classId: 1, keepExp: true },
      {
        kind: "images", actorId: 1, characterName: "Hero", characterIndex: 3,
        faceName: "HeroFace", faceIndex: 5, battlerName: "HeroBattler",
      },
      { kind: "nickname", actorId: 1, value: "The Swift" },
      { kind: "profile", actorId: 1, value: "No line is trimmed." },
    ]);
    for (const code of [313, 314, 317, 318, 319, 321, 324, 325]) expect(only(cov, code)).toBe("Native");
    expect(only(cov, 315)).toBe("Degraded");
    expect(only(cov, 316)).toBe("Degraded");
    expect(only(cov, 322)).toBe("Degraded");

    const hidden = conv([C(316, 0, [0, 1, 0, 0, 2, false])]);
    expect(hidden.cmds[0]).toMatchObject({
      op: "ext",
      args: { kind: "level", show: false },
    });
    expect(only(hidden.cov, 316)).toBe("Native");
  });

  test("invalid actor database references are reported and dropped", () => {
    const cases: [number, unknown[]][] = [
      [311, [0, 99, 0, 0, 1, false]],
      [313, [0, 1, 0, 99]],
      [318, [0, 1, 0, 99]],
      [319, [1, 1, 99]],
      [321, [1, 99, false]],
      [322, [99, "", 0, "", 0, ""]],
    ];
    for (const [code, parameters] of cases) {
      const { cmds, cov } = conv([C(code, 0, parameters)]);
      expect(cmds).toEqual([]);
      expect(only(cov, code)).toBe("Dropped");
    }
  });

  test("battle settings preserve authored values and register only non-empty audio", () => {
    const audioCalls: string[] = [];
    const { cmds, cov } = conv([
      C(132, 0, [{ name: "Battle1", volume: 123.5, pitch: 47, pan: -120 }]),
      C(133, 0, [{ name: "", volume: 80, pitch: 90, pan: 4 }]),
      C(139, 0, [{ name: "Defeat1", volume: 77, pitch: 101, pan: 8 }]),
      C(283, 0, ["Lava", "Clouds"]),
      C(136, 0, [0]),
      C(136, 0, [1]),
    ], { audioCalls });
    expect(cmds.map((c) => c.op === "ext" ? c.args : null)).toEqual([
      { kind: "battleBgm", audio: { name: "Battle1", volume: 123.5, pitch: 47, pan: -120, id: "bgm-battle1" } },
      { kind: "victoryMe", audio: { name: "", volume: 80, pitch: 90, pan: 4 } },
      { kind: "defeatMe", audio: { name: "Defeat1", volume: 77, pitch: 101, pan: 8, id: "me-defeat1" } },
      { kind: "battleback", battleback1Name: "Lava", battleback2Name: "Clouds" },
      { kind: "encounter", disabled: true },
      { kind: "encounter", disabled: false },
    ]);
    expect(audioCalls).toEqual(["bgm:Battle1", "me:Defeat1"]);
    for (const code of [132, 133, 139, 283]) expect(only(cov, code)).toBe("Native");
    expect(counts(cov, "command", "136")).toMatchObject({ Native: 2 });
  });
});

// --- screen and audio ---------------------------------------------------------------------------

describe("screen and audio", () => {
  test("Change Parallax scroll speeds convert from source pixels to kit pixels", () => {
    // MV scrolls a looping axis by speed/4 source pixels per frame; the kit
    // scrolls speed/4 kit pixels per reference tick, so a 48 px project's
    // speeds shrink by 16/48 to keep the on-screen rate.
    const { cmds, cov } = conv([C(284, 0, ["Clouds", true, true, 6, -3])]);
    expect(cmds).toEqual([
      { op: "changeParallax", image: "parallax-clouds", loopX: true, loopY: true, sx: 2, sy: -1 },
    ]);
    expect(only(cov, 284)).toBe("Native");
  });

  test("screen effects", () => {
    const { cmds, cov } = conv([
      C(221, 0), C(222, 0),
      C(223, 0, [[0, 0, 0, 0], 30, false]),
      C(224, 0, [[255, 0, 0, 170], 30, true]),
      C(225, 0, [6, 4, 90, false]),
      C(230, 0, [2400]),
    ]);
    expect(cmds).toEqual([
      { op: "screenFade", direction: "out", duration: 0.4, wait: true },
      { op: "screenFade", direction: "in", duration: 0.4, wait: true },
      { op: "screenTone", tone: { r: 0, g: 0, b: 0, gray: 0 }, duration: 0.5, wait: false },
      { op: "screenFlash", color: { r: 255, g: 0, b: 0, a: 255 }, intensity: 170, duration: 0.5, wait: true },
      { op: "screenShake", strength: 4, speed: 3, duration: 1.5, wait: false },
      { op: "wait", seconds: 30 },
      { op: "wait", seconds: 10 },
    ]);
    expect(only(cov, 223)).toBe("Degraded");
    const tint = conv([C(223, 0, [[-68, -68, 0, 68], 60, true])]);
    expect(tint.cmds).toEqual([{
      op: "screenTone", tone: { r: -68, g: -68, b: 0, gray: 68 }, duration: 1, wait: true,
    }]);
    expect(only(tint.cov, 223)).toBe("Degraded");
  });

  test("K-RPGM5 system, weather and tileset commands preserve source operands", () => {
    const { cmds, cov } = conv([
      C(137, 0, [0]),
      C(137, 0, [2]),
      C(138, 0, [[-255, 34, 255]]),
      C(138, 0, [[-1, 2, -3, 77]]),
      C(236, 0, ["rain", 3, 60, false]),
      C(236, 0, ["storm", 9, 45, true]),
      C(236, 0, ["snow", 6, 0, false]),
      C(236, 0, ["none", 0, 30, true]),
      C(282, 0, [7]),
    ]);
    expect(cmds).toEqual([
      { op: "formationAccess", enabled: false },
      { op: "formationAccess", enabled: true },
      { op: "windowTone", tone: { r: -255, g: 34, b: 255, gray: 0 } },
      { op: "windowTone", tone: { r: -1, g: 2, b: -3, gray: 77 } },
      { op: "weather", kind: "rain", power: 3, duration: 1, wait: false },
      { op: "weather", kind: "storm", power: 9, duration: 0.75, wait: true },
      { op: "weather", kind: "snow", power: 6, duration: 0, wait: false },
      { op: "weather", kind: "none", power: 0, duration: 0.5, wait: true },
      { op: "changeTileset", id: "ts7" },
    ]);
    expect(counts(cov, "command", "236").Native).toBe(4);
    for (const code of [137, 138]) expect(counts(cov, "command", String(code)).Degraded).toBeGreaterThan(0);
    expect(counts(cov, "command", "282").Native).toBe(1);
    for (const code of [137, 138, 236, 282]) expect(counts(cov, "command", String(code)).Dropped).toBe(0);
  });

  test.each([
    [137, [], "formation access parameter is malformed"],
    [138, ["blue"], "window tone is malformed"],
    [223, [null, 60, true], "screen tone is malformed"],
    [223, [[0, 0, 0, 0], -1, true], "screen tone duration must be a non-negative frame count"],
    [236, ["hail", 5, 60, false], "unknown weather kind"],
    [236, ["rain", 10, 60, false], "weather power must be an integer from 0 to 9"],
    [236, ["rain", 5, -1, false], "weather duration must be a non-negative frame count"],
    [236, ["rain", 5, 60, 1], "weather wait flag must be boolean"],
    [282, [0], "tileset id must be a positive integer"],
    [282, [999], "tileset 999 does not exist"],
  ] as const)("malformed command %i is dropped with a diagnostic", (code, parameters, reason) => {
    const ctx = makeCtx();
    const cmds = convertCommands([C(code, 0, [...parameters]), END(0)], ctx);
    expect(cmds).toEqual([]);
    const row = ctx.cov.list("command").find((entry) => entry.key === String(code));
    expect(row?.counts.Dropped).toBe(1);
    expect(row?.reasons).toEqual([reason]);
  });

  test("numbered pictures preserve transforms, timing and MV/MZ easing", () => {
    let r = conv([
      C(231, 0, [7, "Hud", 1, 1, 2, 3, 150, 75, 128, 2]),
      C(232, 0, [7, "", 0, 0, 40, 50, 80, 90, 64, 3, 30, true]),
      C(233, 0, [7, -10]),
      C(234, 0, [7, [-300, 34, 999, 300], 90, false]),
      C(235, 0, [7]),
    ]);
    expect(r.cmds).toEqual([
      {
        op: "showPicture", id: 7, layer: "picture", variant: "pic-hud", origin: "center",
        x: { variable: "v002" }, y: { variable: "v003" }, scaleX: 150, scaleY: 75, opacity: 128, blend: "multiply",
      },
      {
        op: "movePicture", id: 7, origin: "topLeft", x: 40, y: 50,
        scaleX: 80, scaleY: 90, opacity: 64, blend: "screen", duration: 0.5, wait: true,
      },
      { op: "rotatePicture", id: 7, speed: -5 },
      { op: "tintPicture", id: 7, tone: { r: -255, g: 34, b: 255, gray: 255 }, duration: 1.5, wait: false },
      { op: "erasePicture", id: 7 },
    ]);
    for (const code of [231, 232, 233, 234, 235]) expect(only(r.cov, code)).toBe("Native");

    r = conv([C(232, 0, [4, "", 1, 1, 8, 9, 125, 110, 200, 1, 120, false, 3])], { flavor: "MZ" });
    expect(r.cmds).toEqual([{
      op: "movePicture", id: 4, origin: "center", x: { variable: "v008" }, y: { variable: "v009" },
      scaleX: 125, scaleY: 110, opacity: 200, blend: "add", duration: 2, wait: false, easing: "easeInOut",
    }]);
    expect(only(r.cov, 232)).toBe("Native");
  });

  test("map name display toggles both ways", () => {
    const { cmds, cov } = conv([C(281, 0, [0]), C(281, 0, [1])]);
    expect(cmds).toEqual([
      { op: "mapNameDisplay", visible: true },
      { op: "mapNameDisplay", visible: false },
    ]);
    expect(counts(cov, "command", "281")).toMatchObject({ Native: 2 });
  });

  test("audio", () => {
    const a = (name: string, pan = 0) => ({ name, volume: 80, pitch: 110, pan });
    const { cmds, cov } = conv([
      C(241, 0, [a("Town1")]), C(241, 0, [a("")]), C(242, 0, [2]), C(243, 0), C(244, 0),
      C(245, 0, [a("Rain")]), C(245, 0, [a("")]), C(246, 0, [1]),
      C(249, 0, [a("Inn")]), C(250, 0, [a("Cursor1", 20)]), C(250, 0, [a("")]),
    ]);
    expect(cmds).toEqual([
      { op: "playBgm", id: "bgm-town1", volume: 80, pitch: 110 },
      { op: "stopBgm" },
      { op: "fadeoutBgm", duration: 2 },
      { op: "saveBgm" },
      { op: "replayBgm" },
      { op: "playBgs", id: "bgs-rain", volume: 80, pitch: 110 },
      { op: "fadeoutBgs", duration: 0 },
      { op: "fadeoutBgs", duration: 1 },
      { op: "playMe", id: "me-inn", duration: 0, volume: 80, pitch: 110 },
      { op: "playSe", id: "se-cursor1", volume: 80, pitch: 110, pan: 20 },
    ]);
    expect(counts(cov, "command", "241")).toMatchObject({ Native: 2 });
    expect(counts(cov, "command", "249")).toMatchObject({ Native: 1 });
    expect(counts(cov, "command", "250")).toMatchObject({ Native: 2 });
  });
});

// --- battle, shop, name input, placeholders ------------------------------------------------------

describe("battle, shop, name input", () => {
  test("battle branches", () => {
    const { cmds, cov } = conv([
      C(301, 0, [0, 1, true, false]),
      C(601, 0), C(121, 1, [1, 1, 0]), END(1),
      C(602, 0), C(121, 1, [2, 2, 0]), END(1),
      C(604, 0),
    ]);
    expect(cmds).toEqual([{
      op: "battle",
      setup: { system: "rpgmaker", databaseHash: "a".repeat(64), canEscape: true, canLose: false, troop: 1, name: "Bats" },
      onWin: [{ op: "switch", id: "s001", value: true }],
      onEscape: [{ op: "switch", id: "s002", value: true }],
      onLose: [{ op: "gameOver" }, { op: "exit" }],
    }]);
    expect(only(cov, 301)).toBe("Native");
    const lose = conv([C(301, 0, [1, 4, false, true]), C(603, 0), C(115, 1), END(1), C(604, 0)]);
    expect(lose.cmds).toEqual([{
      op: "battle", setup: { system: "rpgmaker", databaseHash: "a".repeat(64), canEscape: false, canLose: true, troopVariable: "v004" }, onLose: [{ op: "exit" }],
    }]);
  });

  test("side-view Battle Processing is reported as front-view degradation", () => {
    const { cmds, cov } = conv([C(301, 0, [2, 0, true, false])], { sideView: true });
    expect(cmds).toEqual([{
      op: "battle",
      setup: {
        system: "rpgmaker", databaseHash: "a".repeat(64), canEscape: true, canLose: false, encounter: true,
      },
      onLose: [{ op: "gameOver" }, { op: "exit" }],
    }]);
    expect(only(cov, 301)).toBe("Degraded");
  });

  test("shop goods", () => {
    const { cmds, cov } = conv([C(302, 0, [0, 1, 0, 0, true]), C(605, 0, [1, 2, 1, 750]), C(605, 0, [2, 3, 0, 0])]);
    expect(cmds).toEqual([{
      op: "shop", id: "shop1",
      goods: [{ item: "item001" }, { item: "weapon002", price: 750 }, { item: "armor003" }],
      sell: false,
    }]);
    expect(only(cov, 302)).toBe("Native");
  });

  test("name input", () => {
    let r = conv([C(303, 0, [1, 6])]);
    expect(r.cmds).toEqual([{ op: "scene", id: "rpgkit.nameInput", args: { maxLength: 6, swallowCancel: true, title: "Harold" } }]);
    expect(only(r.cov, 303)).toBe("Native");
    r = conv([C(303, 0, [2, 8])]);
    expect(r.cmds).toEqual([{ op: "scene", id: "rpgkit.nameInput", args: { maxLength: 8, swallowCancel: true, variable: "actor002-name", title: "Therese" } }]);
    expect(only(r.cov, 303)).toBe("Native");
  });

  test("change name maps actor 1 and reports unsupported actor names", () => {
    let r = conv([C(320, 0, [1, "Wren"])]);
    expect(r.cmds).toEqual([{ op: "changeName", name: "Wren" }]);
    expect(only(r.cov, 320)).toBe("Native");

    r = conv([C(320, 0, [2, "Therese"])]);
    expect(r.cmds).toEqual([]);
    expect(only(r.cov, 320)).toBe("Degraded");

    r = conv([C(320, 0, [1, "abcdefghijklmnopqrstuvwxyz"])]);
    expect(r.cmds).toEqual([{ op: "changeName", name: "abcdefghijklmnopqrstuvwx" }]);
    expect(only(r.cov, 320)).toBe("Degraded");
  });

  test("name commands follow a non-actor-1 starting leader", () => {
    let r = conv([C(303, 0, [2, 8])], { party: [2, 1] });
    expect(r.cmds).toEqual([{
      op: "scene", id: "rpgkit.nameInput",
      args: { maxLength: 8, swallowCancel: true, title: "Therese" },
    }]);
    expect(only(r.cov, 303)).toBe("Native");

    r = conv([C(303, 0, [1, 8])], { party: [2, 1] });
    expect(r.cmds).toEqual([{
      op: "scene", id: "rpgkit.nameInput",
      args: { maxLength: 8, swallowCancel: true, variable: "actor001-name", title: "Harold" },
    }]);
    expect(only(r.cov, 303)).toBe("Native");

    r = conv([C(320, 0, [2, "Leader"])] , { party: [2, 1] });
    expect(r.cmds).toEqual([{ op: "changeName", name: "Leader" }]);
    expect(only(r.cov, 320)).toBe("Native");

    r = conv([C(320, 0, [1, "Companion"])] , { party: [2, 1] });
    expect(r.cmds).toEqual([]);
    expect(only(r.cov, 320)).toBe("Degraded");
  });

  test("host actions map directly and terminal actions exit before later commands", () => {
    let r = conv([C(351, 0), C(352, 0)]);
    expect(r.cmds).toEqual([{ op: "openMenu" }, { op: "openSave" }]);
    expect(only(r.cov, 351)).toBe("Native");
    expect(only(r.cov, 352)).toBe("Native");

    r = conv([C(353, 0), C(121, 0, [1, 1, 0])]);
    expect(r.cmds).toEqual([
      { op: "gameOver" }, { op: "exit" },
      { op: "switch", id: "s001", value: true },
    ]);
    expect(only(r.cov, 353)).toBe("Native");

    r = conv([C(354, 0), C(121, 0, [2, 2, 0])]);
    expect(r.cmds).toEqual([
      { op: "returnTitle" }, { op: "exit" },
      { op: "switch", id: "s002", value: true },
    ]);
    expect(only(r.cov, 354)).toBe("Native");
  });

  test("observed requestRefresh Script is an exact native no-op", () => {
    const { cmds, cov } = conv([C(355, 0, ["$gameMap.requestRefresh();"])]);
    expect(cmds).toEqual([]);
    expect(only(cov, 355)).toBe("Native");
    expect(counts(cov, "script", "$gameMap.requestRefresh()")).toMatchObject({ Native: 1 });
  });

  test("safe Script actions lower to existing commands and execute state writes", () => {
    const audioCalls: string[] = [];
    const { cmds, cov } = conv([
      C(355, 0, [
        "$gameVariables.setValue(2, $gameVariables.value(1) + 3);",
      ]),
      C(355, 0, ["$gameSwitches.setValue(3, true);"]),
      C(355, 0, ["$gameSelfSwitches.setValue([1, 2, 'A'], true);"]),
      C(355, 0, ["$gameParty.gainItem($dataItems[1], 2);"]),
      C(355, 0, ["$gameParty.gainGold(40);"]),
    ], { audioCalls });
    const s = runKit(cmds, { variables: { v001: 4 } });
    expect(s.sw.variables.v002).toBe(7);
    expect(s.sw.switches.s003).toBe(true);
    expect(s.sw.self["m/e"]).toBe("A");
    expect(s.sw.items.item001).toBe(2);
    expect(s.sw.gold).toBe(40);
    expect(counts(cov, "script", "$gameVariables.setValue(id, expression)").Native).toBe(1);
    expect(counts(cov, "script", "$gameSwitches.setValue(id, boolean)").Native).toBe(1);
    expect(counts(cov, "script", "$gameSelfSwitches.setValue([map,event,key], boolean)").Native).toBe(1);
    expect(counts(cov, "script", "$gameParty.gainItem(dataItem, expression)").Degraded).toBe(1);
    expect(counts(cov, "script", "$gameParty.gainGold(expression)").Degraded).toBe(1);
  });

  test("safe Script movement, audio and message calls retain literal operands", () => {
    const audioCalls: string[] = [];
    const cases = [
      ["$gamePlayer.locate(8, 11);", "Degraded", { op: "place", target: "player", x: 8, y: 11 }],
      ["$gamePlayer.reserveTransfer(3, 4, 5, 6, 2);", "Native", { op: "transfer", map: "map003", x: 4, y: 5, dir: "right" }],
      ["$gameMap.event(1).setPosition(6, 7);", "Native", { op: "place", target: { event: "ev001" }, x: 6, y: 7 }],
      ["$gameMap.event(1).setDirection(8);", "Degraded", { op: "moveRoute", target: { event: "ev001" } }],
      ["AudioManager.playSe({name:'Bell',volume:80,pitch:110,pan:-20});", "Native", { op: "playSe", id: "se-bell", volume: 80, pitch: 110, pan: -20 }],
      ["AudioManager.playBgm({name:'Theme'});", "Native", { op: "playBgm", id: "bgm-theme", volume: 0, pitch: 50 }],
      ["$gameMessage.add('Hello \\\\V[2]');", "Native", { op: "text", lines: ["Hello \\V[2]"] }],
    ] as const;
    for (const [source, disposition, expected] of cases) {
      const { cmds, cov } = conv([C(355, 0, [source])], { audioCalls });
      expect(cmds[0]).toMatchObject(expected);
      expect(only(cov, 355)).toBe(disposition);
    }
    expect(audioCalls).toEqual(["se:Bell", "bgm:Theme"]);
  });

  test("safe Script ids and cross-event self-switch targets fail closed", () => {
    for (const source of [
      "$gameVariables.setValue(99, 1);",
      "$gameSwitches.setValue(99, true);",
      "$gameSelfSwitches.setValue([1, 1, 'A'], true);",
    ]) {
      const { cmds, cov } = conv([C(355, 0, [source])]);
      expect(cmds[0]).toMatchObject({ op: "text" });
      expect(only(cov, 355)).toBe("Placeholder");
    }
  });

  test("safe Script conditions lower hasItem, numItems, variables, direction and steps", () => {
    const thenCommand: Command = { op: "switch", id: "s001", value: true };
    const elseCommand: Command = { op: "switch", id: "s002", value: true };
    const cases = [
      ["($gameParty.hasItem($dataItems[1]))", { kind: "item", id: "item001", count: 1 }, false],
      ["!$gameParty.hasItem($dataItems[1])", { kind: "item", id: "item001", count: 1 }, true],
      ["$gameVariables.value(2) > 4", { kind: "variable", id: "v002", op: ">=", value: 5 }, false],
      ["$gamePlayer.direction() !== 8", { kind: "facing", dir: "up" }, true],
      ["$gameParty.steps() < 3", { kind: "steps", op: "<=", value: 2 }, false],
    ] as const;
    for (const [source, condition, swapped] of cases) {
      const { cmds, cov } = conv(conditionalBranch([12, source], true));
      expect(cmds[0]).toMatchObject({ op: "if", if: condition });
      if (cmds[0]?.op === "if") {
        expect(cmds[0].then[0]).toEqual(swapped ? elseCommand : thenCommand);
      }
      expect(only(cov, 111)).toBe("Native");
    }

    const counted = conv(conditionalBranch([12, "$gameParty.numItems($dataItems[1]) >= 2"], true));
    expect(counted.cmds.some((command) => command.op === "if" && command.if.kind === "item")).toBe(true);
    expect(counted.cmds.at(-1)).toMatchObject({ op: "if", if: { kind: "variable", op: ">=", value: 2 } });
    expect(counts(counted.cov, "script", "$gameParty.numItems(dataItem) comparison number").Native).toBe(1);
  });

  test("player-coordinate Script condition remains a classified placeholder", () => {
    const { cmds, cov } = conv(conditionalBranch([12, "$gamePlayer.x === 4"], true));
    expect(cmds[0]).toMatchObject({ op: "text" });
    expect(only(cov, 111)).toBe("Placeholder");
    expect(counts(cov, "script", "$gamePlayer.x comparison number").Placeholder).toBe(1);
  });

  test.each([
    ["visible", [
      { op: "text", lines: ["[Script not ported:", "$gameVariables.setValue(1, 2); foo();]"] },
    ]],
    ["silent", []],
  ] as const)("script placeholders and typed plugin calls (%s)", (mode, expected) => {
    const { cmds, cov } = conv([
      C(355, 0, ["$gameVariables.setValue(1, 2);"]), C(655, 0, ["foo();"]),
      C(356, 0, ["ShowMap 1"]),
      C(357, 0, ["Quest", "start", "Start", { id: "3" }]), C(657, 0, ["Id = 3"]),
    ], { placeholders: mode });
    expect(cmds).toEqual([
      ...expected,
      { op: "ext", call: "rpgmaker.pluginCommand", args: { source: "MV", line: "ShowMap 1" } },
      { op: "ext", call: "rpgmaker.pluginCommand", args: {
        source: "MZ", plugin: "Quest", command: "start", displayName: "Start",
        arguments: { id: "3" }, annotations: ["Id = 3"],
      } },
    ] as Command[]);
    expect(only(cov, 355)).toBe("Placeholder");
    expect(only(cov, 356)).toBe("Degraded");
    expect(only(cov, 357)).toBe("Degraded");
  });
});

// --- pages and common events -------------------------------------------------------------------

describe("pages", () => {
  test("page fields, conditions and custom route", () => {
    const ctx = makeCtx();
    const page = convertPage(rmPage([C(121, 0, [1, 1, 0])], {
      conditions: {
        ...NO_CONDS,
        switch1Valid: true, switch1Id: 3, switch2Valid: true, switch2Id: 4,
        variableValid: true, variableId: 5, variableValue: 10,
        selfSwitchValid: true, selfSwitchCh: "C", itemValid: true, itemId: 2, actorValid: true, actorId: 2,
      },
      image: { tileId: 0, characterName: "People1", characterIndex: 3, direction: 4, pattern: 1 },
      priorityType: 1, trigger: 2, moveType: 3, moveSpeed: 4, moveFrequency: 5, directionFix: true,
      moveRoute: { list: [{ code: 2 }, { code: 15, parameters: [16] }, { code: 0 }], repeat: true, skippable: true, wait: false },
    }), 1, ctx);
    expect(page).toEqual({
      trigger: "eventTouch",
      condition: {
        variable: { id: "v005", op: ">=", value: 10 },
        selfSwitch: "C",
        item: "item002",
        all: [{ kind: "switch", id: "s003" }, { kind: "switch", id: "s004" }, { kind: "switch", id: "party-actor002" }],
      },
      sprite: "rm-people1-3",
      dir: "left",
      blocks: true,
      moveSpeed: 4,
      moveFrequency: 5,
      directionFix: true,
      moveRoute: { steps: ["moveLeft", "wait"], repeat: true, skippable: true },
      commands: [{ op: "switch", id: "s001", value: true }],
    });
    expectSchemaValid(page, { $ref: "#/$defs/page" });
    expect(counts(ctx.cov, "trigger", "eventTouch")).toMatchObject({ Native: 1 });
    for (const k of ["variable", "selfSwitch", "item", "actor"]) expect(counts(ctx.cov, "pageCondition", k).Native).toBe(1);
    expect(counts(ctx.cov, "pageCondition", "switch").Native).toBe(2);
  });

  test("no conditions; random move; native trigger table", () => {
    const ctx = makeCtx();
    expect(convertPageConditions(NO_CONDS, ctx)).toBeUndefined();
    for (const [rm, kit] of [[0, "action"], [1, "playerTouch"], [2, "eventTouch"], [3, "autorun"], [4, "parallel"]] as const) {
      const page = convertPage(rmPage([], { trigger: rm, moveType: 1 }), 0, ctx);
      expect(page.trigger).toBe(kit);
      expect(page.moveType).toBe("random");
      expect(page.sprite).toBeNull();
      expectSchemaValid(page, { $ref: "#/$defs/page" });
    }
  });

  test("a blocking Player Touch page maps to eventTouch but a below-character page stays playerTouch", () => {
    const blockingCtx = makeCtx();
    const blocking = convertPage(rmPage([C(121, 0, [1, 1, 0])], { trigger: 1, priorityType: 1 }), 0, blockingCtx);
    expect(blocking).toMatchObject({ trigger: "eventTouch", blocks: true });
    expect(counts(blockingCtx.cov, "trigger", "playerTouch")).toMatchObject({ Degraded: 1, Native: 0 });

    const belowCtx = makeCtx();
    const below = convertPage(rmPage([C(121, 0, [1, 1, 0])], { trigger: 1, priorityType: 0 }), 0, belowCtx);
    expect(below).toMatchObject({ trigger: "playerTouch", blocks: false });
    expect(counts(belowCtx.cov, "trigger", "playerTouch")).toMatchObject({ Native: 1, Degraded: 0 });
  });

  test.each([[0, false], [1, true], [2, false]] as const)(
    "Event Touch priority %i stays native and blocks=%s",
    (priorityType, blocks) => {
      const ctx = makeCtx();
      const page = convertPage(rmPage([C(121, 0, [1, 1, 0])], { trigger: 2, priorityType }), 0, ctx);
      expect(page).toMatchObject({ trigger: "eventTouch", blocks });
      expect(counts(ctx.cov, "trigger", "eventTouch")).toMatchObject({ Native: 1, Degraded: 0 });
    },
  );
});

describe("common events", () => {
  const common = (trigger: "none" | "parallel" | "autorun"): Owner => ({ kind: "common", id: "ce002", trigger });

  test("autorun becomes parallel under its switch", () => {
    const ctx = makeCtx({ owner: common("none") });
    const ce = convertCommonEvent({ id: 2, name: "Clock", trigger: 1, switchId: 7, list: [C(123, 0, ["A", 0]), C(214, 0), END(0)] }, ctx);
    expect(ce).toEqual({ id: "ce002", name: "Clock", trigger: "parallel", conditionSwitch: "s007", commands: [] });
    expectSchemaValid(ce, { $ref: "#/$defs/commonEvent" });
    expect(counts(ctx.cov, "trigger", "common autorun")).toMatchObject({ Degraded: 1 });
    // Self switch and erase do nothing without an event in RM.
    expect(counts(ctx.cov, "command", "123")).toMatchObject({ Native: 1 });
  });

  test("this-event commands do nothing in a parallel common event", () => {
    const ctx = makeCtx({ owner: common("none") });
    const route = { list: [{ code: 1 }, { code: 0 }], repeat: false, skippable: false, wait: true };
    const ce = convertCommonEvent({
      id: 2, name: "", trigger: 2, switchId: 1,
      list: [C(205, 0, [0, route]), C(213, 0, [0, 1, false]), C(203, 0, [0, 0, 1, 1, 0]), C(205, 0, [-1, route]), END(0)],
    }, ctx);
    expect(ce.commands).toEqual([{ op: "moveRoute", target: "player", wait: true, route: { steps: ["moveDown"], repeat: false, skippable: false } }]);
    for (const code of ["205", "213", "203"]) expect(counts(ctx.cov, "command", code).Dropped).toBe(0);
  });

  test("exit inside a called common event also ends the caller", () => {
    const ctx = makeCtx({ owner: common("none") });
    const ce = convertCommonEvent({ id: 2, name: "", trigger: 0, switchId: 0, list: [C(115, 0), END(0)] }, ctx);
    expect(ce).toEqual({ id: "ce002", trigger: "none", commands: [{ op: "exit" }] });
    expect(counts(ctx.cov, "command", "115")).toMatchObject({ Degraded: 1 });
  });

  test("a parallel common event keeps its whole-body loop native", () => {
    const ctx = makeCtx({ owner: common("none") });
    const ce = convertCommonEvent({
      id: 2, name: "", trigger: 2, switchId: 1,
      list: [C(112, 0), C(230, 1, [6]), END(1), C(413, 0), END(0)],
    }, ctx);
    expect(ce.commands).toEqual([{ op: "loop", commands: [{ op: "wait", seconds: 0.1 }] }]);
    expect(counts(ctx.cov, "command", "112")).toMatchObject({ Native: 1 });
  });
});

// --- catalog ------------------------------------------------------------------------------------

describe("catalog", () => {
  test("codes are unique; tables are complete", () => {
    const codes = RM_COMMANDS.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(RM_CONDITION_TYPES.map((t) => t.type)).toEqual([...Array(14).keys()]);
    expect(RM_ROUTE_CODES.map((r) => r.code)).toEqual([...Array(46).keys()]);
    for (const c of RM_COMMANDS) if (c.continuation) expect(sampleCommands(c.code)).toEqual([]);
  });

  test("every code the converter switches on is in the catalog", async () => {
    const src = await Bun.file(new URL("../tools/rpgmaker-import/events.ts", import.meta.url)).text();
    const emit = src.slice(src.indexOf("function emitNode"), src.indexOf("function exitCommand"));
    const handled = [...emit.matchAll(/case (\d{3}):/g)].map((m) => Number(m[1]));
    expect(handled.length).toBeGreaterThan(50);
    for (const code of handled) expect([code, RM_COMMAND_BY_CODE.has(code)]).toEqual([code, true]);
  });

  test.each(RM_COMMANDS.filter((c) => !c.continuation).map((c) => [c.code, c.name] as const))(
    "%i %s records exactly one disposition",
    (code) => {
      for (const placeholders of ["visible", "silent"] as const) {
        const ctx = makeCtx({ placeholders });
        const list = sampleCommands(code);
        expect(list.length).toBeGreaterThan(0);
        const cmds = convertCommands(list, ctx);
        expectSchemaValid(cmds);
        compile(cmds);
        const row = ctx.cov.list("command").find((r) => r.key === String(code));
        expect(row).toBeDefined();
        const total = Object.values(row!.counts).reduce((a, b) => a + b, 0);
        expect(total).toBe(1);
        const info = RM_COMMAND_BY_CODE.get(code)!;
        // A code the importer cannot map natively says what the kit lacks.
        if (row!.counts.Dropped > 0) expect(info.needsKit ?? row!.reasons[0]).toBeTruthy();
      }
    },
  );
});
