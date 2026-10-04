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
  ME_DEFAULT_SECONDS,
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
import type { RmCommand, RmEventPage, RmMap, RmPageConditions, RmProject } from "../tools/rpgmaker-import/rm-types.ts";
import { convertMessage } from "../tools/rpgmaker-import/text.ts";

// --- fixtures ----------------------------------------------------------------

const C = (code: number, indent: number, parameters: unknown[] = []): RmCommand => ({ code, indent, parameters });
const END = (indent: number): RmCommand => C(0, indent);

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
    id, name, nickname: "", characterName: "", characterIndex: 0, faceName: "", faceIndex: 0, classId: 1, initialLevel: 1, note: "",
  });
  return {
    root: "",
    flavor: "MV",
    system: {
      gameTitle: "T", currencyUnit: "G", partyMembers: [1, 2], startMapId: 1, startX: 0, startY: 0, switches: [], variables: [],
    },
    mapInfos: [null],
    maps: new Map([[1, map1]]),
    tilesets: [null],
    commonEvents: [null, { id: 1, name: "Shared", trigger: 0, switchId: 0, list: [END(0)] }],
    items: [null],
    weapons: [null],
    armors: [null],
    actors: [null, actor(1, "Harold"), actor(2, "Therese")],
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

function makeCtx(opts: { placeholders?: "visible" | "silent"; owner?: Owner; balloon?: boolean; flavor?: "MV" | "MZ" } = {}): EventContext {
  let shop = 0;
  let animation = 0;
  return {
    rm: opts.flavor ? { ...RM, flavor: opts.flavor } : RM,
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
    audio: (kind, name) => audioId(kind, name),
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

function runKit(commands: Command[], init: { gold?: number; variables?: Record<string, number>; items?: Record<string, number> }): InterpState {
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
      ["\\N[1] has \\V[3] \\G, \\c[2]red\\C[0] \\I[5]!", "\\n[2] and \\P[1]/\\P[2] \\\\ \\{big\\} \\.\\|\\!\\>\\<\\^\\$ \\FS[20]x"],
      ctx,
    );
    expect(out).toEqual(["{name} has {v:v003} G, red !", "Therese and {name}/Therese \\ big  x"]);
    const esc = (k: string) => counts(ctx.cov, "escape", k);
    expect(esc("\\N")).toMatchObject({ Native: 1, Degraded: 1 });
    expect(esc("\\V")).toMatchObject({ Native: 1 });
    expect(esc("\\G")).toMatchObject({ Native: 1 });
    expect(esc("\\C")).toMatchObject({ Degraded: 2 });
    expect(esc("\\I")).toMatchObject({ Degraded: 1 });
    expect(esc("\\P")).toMatchObject({ Native: 1, Degraded: 1 });
    expect(esc("\\\\")).toMatchObject({ Native: 1 });
    expect(esc("\\{")).toMatchObject({ Degraded: 1 });
    expect(esc("\\^")).toMatchObject({ Degraded: 1 });
    expect(esc("\\FS")).toMatchObject({ Degraded: 1 });
  });

  test("\\V, \\N, \\P and \\G are replaced before other codes", () => {
    const ctx = makeCtx();
    expect(convertMessage(["\\Gold \\Vx \\Np"], ctx)).toEqual(["Gold  "]);
    expect(counts(ctx.cov, "escape", "\\G")).toMatchObject({ Native: 1 });
    expect(counts(ctx.cov, "escape", "\\VX")).toMatchObject({ Degraded: 1 });
  });

  test("Show Text: lines, face, MZ speaker, wrapping", () => {
    let r = conv([C(101, 0, ["", 0, 0, 2]), C(401, 0, ["Hello \\N[1]."]), C(401, 0, ["Bye."])]);
    expect(r.cmds).toEqual([{ op: "text", lines: ["Hello {name}.", "Bye."] }]);
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

  test("wrapping and choice truncation never split a converted variable token", () => {
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

  test("Show Scrolling Text becomes message pages", () => {
    const r = conv([C(105, 0, [2, false]), ...["a", "b", "c", "d", "e"].map((t) => C(405, 0, [t]))]);
    expect(r.cmds).toEqual([{ op: "text", lines: ["a", "b", "c", "d"] }, { op: "text", lines: ["e"] }]);
    expect(only(r.cov, 105)).toBe("Degraded");
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
  const branch = (params: unknown[], withElse = false): RmCommand[] => [
    C(111, 0, params), C(121, 1, [1, 1, 0]), END(1),
    ...(withElse ? [C(411, 0), C(121, 1, [2, 2, 0]), END(1)] : []),
    C(412, 0),
  ];
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
    ["actor name", [4, 2, 1, "Bob"], dead([THEN], [ELSE]), "actor", "Degraded"],
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
    ["vehicle", [13, 0], dead([THEN], [ELSE]), "vehicle", "Degraded"],
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

  test("script condition: placeholder in both modes", () => {
    const placeholder = { op: "text", lines: ["[Script condition not ported:", "$gameParty.size() > 2]"] } as Command;
    let r = conv(branch([12, "$gameParty.size() > 2"], true));
    expect(r.cmds).toEqual(dead([THEN], [ELSE], [placeholder]));
    expect(only(r.cov, 111)).toBe("Placeholder");
    r = conv(branch([12, "x"], true), { placeholders: "silent" });
    expect(r.cmds).toEqual(dead([THEN], [ELSE]));
    expect(only(r.cov, 111)).toBe("Placeholder");
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
      { op: "screenTint", layer: "tone", color: { r: 0, g: 0, b: 0, a: 0 }, duration: 0.5, wait: false },
      { op: "screenFlash", color: { r: 255, g: 0, b: 0, a: 255 }, intensity: 170, duration: 0.5, wait: true },
      { op: "screenShake", strength: 4, speed: 3, duration: 1.5, wait: false },
      { op: "wait", seconds: 30 },
      { op: "wait", seconds: 10 },
    ]);
    expect(only(cov, 223)).toBe("Native");
    const tint = conv([C(223, 0, [[-68, -68, 0, 68], 60, true])]);
    expect(tint.cmds).toEqual([{ op: "screenTint", layer: "tone", color: { r: 0, g: 0, b: 128, a: 68 }, duration: 1, wait: true }]);
    expect(only(tint.cov, 223)).toBe("Degraded");
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
      { op: "playMe", id: "me-inn", duration: ME_DEFAULT_SECONDS, volume: 80, pitch: 110 },
      { op: "playSe", id: "se-cursor1", volume: 80, pitch: 110 },
    ]);
    expect(counts(cov, "command", "241")).toMatchObject({ Native: 2 });
    expect(counts(cov, "command", "249")).toMatchObject({ Degraded: 1 });
    expect(counts(cov, "command", "250")).toMatchObject({ Degraded: 1, Native: 1 });
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
      setup: { system: "rpgmaker", canEscape: true, canLose: false, troop: 1, name: "Bats" },
      onWin: [{ op: "switch", id: "s001", value: true }],
      onEscape: [{ op: "switch", id: "s002", value: true }],
    }]);
    expect(only(cov, 301)).toBe("Placeholder");
    const lose = conv([C(301, 0, [1, 4, false, true]), C(603, 0), C(115, 1), END(1), C(604, 0)]);
    expect(lose.cmds).toEqual([{
      op: "battle", setup: { system: "rpgmaker", canEscape: false, canLose: true, troopVariable: "v004" }, onLose: [{ op: "exit" }],
    }]);
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
    expect(only(r.cov, 303)).toBe("Degraded");
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

  test.each([
    ["visible", [
      { op: "text", lines: ["[Script not ported:", "$gameVariables.setValue(1, 2); foo();]"] },
      { op: "text", lines: ["[Plugin command not ported:", "ShowMap 1]"] },
      { op: "text", lines: ["[Plugin command not ported:", "Quest:start]"] },
    ]],
    ["silent", []],
  ] as const)("script and plugin placeholders (%s)", (mode, expected) => {
    const { cmds, cov } = conv([
      C(355, 0, ["$gameVariables.setValue(1, 2);"]), C(655, 0, ["foo();"]),
      C(356, 0, ["ShowMap 1"]),
      C(357, 0, ["Quest", "start", "Start", { id: "3" }]), C(657, 0, ["Id = 3"]),
    ], { placeholders: mode });
    expect(cmds).toEqual(expected as unknown as Command[]);
    expect(only(cov, 355)).toBe("Placeholder");
    expect(only(cov, 356)).toBe("Placeholder");
    expect(only(cov, 357)).toBe("Placeholder");
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
