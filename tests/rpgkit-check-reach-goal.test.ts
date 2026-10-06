// tests/rpgkit-check-reach-goal.test.ts — the reach goal grammar: parsing,
// canonical formatting, evaluation against real engine states, and project
// validation.

import { describe, expect, test } from "bun:test";
import {
  evalGoal,
  evalGoalExpr,
  formatGoalExpr,
  leafGoals,
  parseGoalExpr,
  parseGoals,
  validateGoalsAgainstProject,
  GoalParseError,
  type GoalCmpOp,
  type ReachGoal,
  type ReachGoalExpr,
} from "../tools/rpgkit-check/src/dynamic/reach-goal.ts";
import { checkSessionOptions } from "../tools/rpgkit-check/src/dynamic/sim.ts";
import { createSession, startSession, type Session } from "../src/engine/session.ts";
import type { GameEvent, MapDef, Project } from "../src/engine/types.ts";

function grassMap(id: string, events: GameEvent[] = []): MapDef {
  return {
    id,
    name: id,
    width: 5,
    height: 5,
    sheets: ["grass"],
    ground: new Array<string>(25).fill("grass.0"),
    events,
  };
}

function fixtureProject(maps: MapDef[], startMap = "A"): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Goal fixture",
    tileSize: 16,
    start: { map: startMap, x: 0, y: 0, dir: "down" },
    sheets: [{ id: "grass", cols: 1, rows: 1 }],
    items: [],
    sprites: {},
    maps,
  };
}

function freshSession(project: Project): Session {
  return createSession(project, 60, checkSessionOptions(project));
}

function stateAt(project: Project, sw?: {
  switches?: Record<string, boolean>;
  variables?: Record<string, number>;
  items?: Record<string, number>;
  gold?: number;
  self?: Record<string, string>;
}) {
  const session = freshSession(project);
  let state = startSession(project, session);
  if (sw) {
    state = {
      ...state,
      sw: {
        ...state.sw,
        ...(sw.switches ? { switches: { ...state.sw.switches, ...sw.switches } } : {}),
        ...(sw.variables ? { variables: { ...state.sw.variables, ...sw.variables } } : {}),
        ...(sw.items ? { items: { ...state.sw.items, ...sw.items } } : {}),
        ...(sw.self ? { self: { ...state.sw.self, ...sw.self } as typeof state.sw.self } : {}),
        gold: sw.gold ?? state.sw.gold,
      },
    };
  }
  return { session, state };
}

const evalExpr = (project: Project, expr: string, sw?: Parameters<typeof stateAt>[1]) => {
  const { session, state } = stateAt(project, sw);
  return evalGoalExpr(parseGoalExpr(expr), { state, session });
};

// --- parsing -----------------------------------------------------------------------

describe("reach goal grammar", () => {
  test("every predicate form parses and round-trips canonically", () => {
    const cases: [string, string][] = [
      ["switch:warehouse-rewarded", "switch:warehouse-rewarded=true"],
      ["switch:gate=true", "switch:gate=true"],
      ["switch:gate=false", "switch:gate=false"],
      ["variable:count>=3", "variable:count>=3"],
      ["variable: x != 0", "variable:x!=0"],
      ["variable:gold==5", "variable:gold==5"],
      ["item:thorn-key", "item:thorn-key"],
      ["item:torch>=2", "item:torch>=2"],
      ["gold>=80", "gold>=80"],
      ["gold>5", "gold>5"],
      ["selfSwitch:guard-warehouse/warehouse-epilogue/A", "selfSwitch:guard-warehouse/warehouse-epilogue/A"],
      ["selfSwitch:m/e/B=false", "selfSwitch:m/e/B=false"],
      ["event-page:village/chest=1", "event-page:village/chest=1"],
      ["map:grassland", "map:grassland"],
      ["map:grassland@1,6", "map:grassland@1,6"],
      ["grassland@1,6", "map:grassland@1,6"],
      ["all(switch:a, switch:b)", "all(switch:a=true, switch:b=true)"],
      ["any(switch:a, all(switch:b, switch:c))", "any(switch:a=true, all(switch:b=true, switch:c=true))"],
    ];
    for (const [input, canonical] of cases) {
      expect(formatGoalExpr(parseGoalExpr(input))).toBe(canonical);
    }
  });

  test("parseGoals wraps multiple goals in the mode", () => {
    expect(formatGoalExpr(parseGoals(["switch:a", "switch:b"]))).toBe("all(switch:a=true, switch:b=true)");
    expect(formatGoalExpr(parseGoals(["switch:a", "switch:b"], "any"))).toBe("any(switch:a=true, switch:b=true)");
    // A single goal is returned unwrapped.
    expect(formatGoalExpr(parseGoals(["switch:a"]))).toBe("switch:a=true");
  });

  test("leafGoals flattens combinators left to right", () => {
    const expr = parseGoalExpr("all(switch:a, any(switch:b, switch:c), map:B)");
    expect(leafGoals(expr).map((g) => formatGoalExpr(g))).toEqual([
      "switch:a=true",
      "switch:b=true",
      "switch:c=true",
      "map:B",
    ]);
  });

  test("grammar errors say what was wrong", () => {
    const bad = [
      "",
      "switch:",
      "switch:a=maybe",
      "variable:x",
      "variable:x~3",
      "variable:x>=",
      "item:",
      "gold",
      "gold>=",
      "gold>",
      "selfSwitch:only-two/parts",
      "selfSwitch:a/b/",
      "selfSwitch:A/chest/a",
      "selfSwitch:A/chest/E",
      "event-page:m/e",
      "event-page:m/e=-1",
      "map:m@1",
      "map:m@1,two",
      "all(switch:a",
      "all()",
      // A trailing combinator after a closed expression is unbalanced parens,
      // not one switch id full of punctuation.
      "all(switch:done), any(switch:x)",
      "switch:a(b)",
      "notagoal",
    ];
    for (const input of bad) {
      expect(() => parseGoalExpr(input)).toThrow(GoalParseError);
    }
  });

  test("an empty comparator operand is an error, not a silent zero", () => {
    // gold>= parsed as gold>=0 and "proved" itself at frame 0.
    expect(() => parseGoalExpr("gold>=")).toThrow(/empty value/);
    expect(() => parseGoalExpr("variable:x>=")).toThrow(/empty value/);
    expect(() => parseGoalExpr("item:torch>=")).toThrow(/empty value/);
  });

  test("a selfSwitch key outside A..D is rejected", () => {
    // The engine only holds A..D; a lowercase key can never satisfy a goal.
    expect(() => parseGoalExpr("selfSwitch:A/chest/a")).toThrow(/A, B, C, D/);
    expect(() => parseGoalExpr("selfSwitch:A/chest/aa")).toThrow(/A, B, C, D/);
  });
});

// --- round-trip property ---------------------------------------------------------------
//
// A witness records formatGoalExpr(expr) and the replay side re-parses it,
// so the two must be exact inverses for every goal type and every all/any/
// nested shape — including a map@x,y goal, whose coordinate comma must not
// be mistaken for a separator.

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RT_IDS = ["a", "b", "chest-01", "warehouse", "map_x", "done", "count", "thorn-key", "village"];
const RT_OPS: GoalCmpOp[] = ["==", "!=", ">=", "<=", ">", "<"];
const RT_KEYS = ["A", "B", "C", "D"] as const;

function genAtom(rng: () => number): ReachGoal {
  const id = RT_IDS[Math.floor(rng() * RT_IDS.length)]!;
  switch (Math.floor(rng() * 7)) {
    case 0:
      return { kind: "switch", id, value: rng() < 0.5 };
    case 1:
      return { kind: "variable", id, op: RT_OPS[Math.floor(rng() * RT_OPS.length)]!, value: Math.floor(rng() * 100) };
    case 2:
      return { kind: "item", id, op: RT_OPS[Math.floor(rng() * RT_OPS.length)]!, count: Math.floor(rng() * 10) };
    case 3:
      return { kind: "gold", op: RT_OPS[Math.floor(rng() * RT_OPS.length)]!, value: Math.floor(rng() * 1000) };
    case 4:
      return {
        kind: "selfSwitch",
        map: id,
        event: "ev",
        key: RT_KEYS[Math.floor(rng() * RT_KEYS.length)]!,
        value: rng() < 0.5,
      };
    case 5:
      return { kind: "eventPage", map: id, event: "ev", page: Math.floor(rng() * 4) };
    default: {
      // A bare map half the time, a map@x,y the other half — the coordinate
      // comma is the regression this test pins.
      const withTile = rng() < 0.5;
      return {
        kind: "map",
        id,
        ...(withTile ? { x: Math.floor(rng() * 10), y: Math.floor(rng() * 10) } : {}),
      };
    }
  }
}

function genExpr(rng: () => number, depth: number): ReachGoalExpr {
  if (depth <= 0 || rng() < 0.4) return genAtom(rng);
  const op = rng() < 0.5 ? "all" : "any";
  const n = 1 + Math.floor(rng() * 3);
  return { op, goals: Array.from({ length: n }, () => genExpr(rng, depth - 1)) };
}

describe("reach goal format→parse round-trip", () => {
  test("every atom type and nested all/any shape round-trips (seeded)", () => {
    const rng = mulberry32(20261006);
    let withMapTile = 0;
    let combined = 0;
    for (let i = 0; i < 500; i++) {
      const expr = genExpr(rng, 3);
      const text = formatGoalExpr(expr);
      if (text.includes("@")) withMapTile++;
      if (text.startsWith("all(") || text.startsWith("any(")) combined++;
      // The replay side's exact path: parse the canonical text back.
      expect(parseGoalExpr(text)).toEqual(expr);
      // Formatting the parse is stable too (a second pass is identical).
      expect(formatGoalExpr(parseGoalExpr(text))).toBe(text);
    }
    // The sample must actually exercise the interesting cases.
    expect(withMapTile).toBeGreaterThan(50);
    expect(combined).toBeGreaterThan(100);
  });

  test("map@x,y combined with other goals round-trips (the N1 regression)", () => {
    const cases = [
      "all(map:A@1,2, switch:done=true)",
      "any(map:A@1,2, gold>=10)",
      "all(any(map:A@1,2, switch:done=true), map:B@3,4)",
      "all(map:A@1,2, map:B@3,4, map:C@5,6)",
      "any(all(map:A@1,2, item:key), all(switch:x=false, map:D@0,0))",
    ];
    for (const text of cases) {
      const expr = parseGoalExpr(text);
      expect(parseGoalExpr(formatGoalExpr(expr))).toEqual(expr);
    }
  });
});

// --- evaluation ---------------------------------------------------------------------

describe("reach goal evaluation", () => {
  const project = fixtureProject([
    grassMap("A", [{
      id: "chest",
      x: 1,
      y: 1,
      pages: [
        { trigger: "action", commands: [] },
        { trigger: "action", condition: { switch: "opened" }, commands: [] },
      ],
    }]),
    grassMap("B"),
  ]);

  test("switch: missing is false, set value must match", () => {
    expect(evalExpr(project, "switch:opened")).toBe(false);
    expect(evalExpr(project, "switch:opened=false")).toBe(true);
    expect(evalExpr(project, "switch:opened", { switches: { opened: true } })).toBe(true);
    expect(evalExpr(project, "switch:opened=false", { switches: { opened: true } })).toBe(false);
  });

  test("variable: missing is 0; numeric comparison; string vars never satisfy", () => {
    expect(evalExpr(project, "variable:count>=1")).toBe(false);
    expect(evalExpr(project, "variable:count==0")).toBe(true);
    expect(evalExpr(project, "variable:count>2", { variables: { count: 3 } })).toBe(true);
    expect(evalExpr(project, "variable:count<=2", { variables: { count: 3 } })).toBe(false);
    expect(evalExpr(project, "variable:count>=1", { variables: { count: "text" as unknown as number } })).toBe(false);
  });

  test("item and gold", () => {
    expect(evalExpr(project, "item:torch")).toBe(false);
    expect(evalExpr(project, "item:torch", { items: { torch: 1 } })).toBe(true);
    expect(evalExpr(project, "item:torch>=2", { items: { torch: 1 } })).toBe(false);
    expect(evalExpr(project, "gold>=80")).toBe(false);
    expect(evalExpr(project, "gold>=80", { gold: 80 })).toBe(true);
  });

  test("selfSwitch: held key must match", () => {
    expect(evalExpr(project, "selfSwitch:A/chest/A")).toBe(false);
    expect(evalExpr(project, "selfSwitch:A/chest/A", { self: { "A/chest": "A" } })).toBe(true);
    expect(evalExpr(project, "selfSwitch:A/chest/A=false", { self: { "A/chest": "B" } })).toBe(true);
  });

  test("eventPage: the active page index under the state", () => {
    expect(evalExpr(project, "event-page:A/chest=0")).toBe(true);
    expect(evalExpr(project, "event-page:A/chest=1")).toBe(false);
    expect(evalExpr(project, "event-page:A/chest=1", { switches: { opened: true } })).toBe(true);
    // Unknown map/event never satisfies (a separate validation pass flags
    // the typo as an error finding).
    expect(evalExpr(project, "event-page:A/nope=0")).toBe(false);
  });

  test("map with and without tile", () => {
    expect(evalExpr(project, "map:A")).toBe(true);
    expect(evalExpr(project, "map:B")).toBe(false);
    expect(evalExpr(project, "map:A@0,0")).toBe(true);
    expect(evalExpr(project, "map:A@1,1")).toBe(false);
  });

  test("all/any combinators", () => {
    expect(evalExpr(project, "all(switch:a, gold>=10)")).toBe(false);
    expect(evalExpr(project, "any(switch:a, gold>=10)")).toBe(false);
    expect(evalExpr(project, "all(switch:a, gold>=10)", { switches: { a: true }, gold: 10 })).toBe(true);
    expect(evalExpr(project, "any(switch:a, gold>=10)", { gold: 10 })).toBe(true);
    expect(evalExpr(project, "any(switch:a, gold>=10)", { switches: { a: true } })).toBe(true);
  });
});

// --- validation -----------------------------------------------------------------------

describe("reach goal validation", () => {
  const project = fixtureProject([
    grassMap("A", [{ id: "chest", x: 0, y: 0, pages: [{ trigger: "action", commands: [] }] }]),
    grassMap("B"),
  ]);

  test("unknown map/event, out-of-bounds tile, page out of range are errors", () => {
    const errors = validateGoalsAgainstProject(
      parseGoals([
        "map:NOPE",
        "map:B@9,9",
        "selfSwitch:NOPE/e/A",
        "selfSwitch:A/NOPE/A",
        "event-page:A/chest=3",
        "switch:fine",
      ]),
      project,
    );
    expect(errors.length).toBe(5);
    expect(errors.join("\n")).toContain("map");
  });

  test("a sound goal set validates clean", () => {
    expect(validateGoalsAgainstProject(
      parseGoals(["switch:opened", "selfSwitch:A/chest/A", "event-page:A/chest=0", "map:B@0,0", "gold>=1"]),
      project,
    )).toEqual([]);
  });
});
