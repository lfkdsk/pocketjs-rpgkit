// tools/rpgkit-check/src/dynamic/reach-goal.ts — state-goal predicates for
// the reach search.
//
// A goal is a predicate over a real engine state: a switch, a variable, an
// item count, gold, a self switch, an event's active page, or a map (with an
// optional tile). Goals combine with all()/any(). The search stops as soon
// as the combined predicate holds at some observed state, and the witness it
// records ends at that state.
//
// The string grammar (CLI --goal, JSON "goals", MCP — one surface):
//
//   switch:<id>[=<bool>]            switch holds (default: true)
//   variable:<id><op><n>            op: == != >= <= > <
//   item:<id>[<op><n>]              default: >=1
//   gold<op><n>                     e.g. gold>=80
//   selfSwitch:<map>/<event>/<key>[=<bool>]
//   event-page:<map>/<event>=<page> active page index
//   map:<id>[@<x>,<y>]              (a bare <id>@<x>,<y> also parses)
//   all(<goal>, ...) | any(<goal>, ...)   nestable
//
// Whitespace around tokens is ignored. Evaluation mirrors the engine's own
// condition semantics (interpreter.ts pageConditionHolds): a missing switch
// is false, a missing variable is 0, a missing item count is 0, and a
// variable an extension wrote a string to never satisfies a numeric goal.

import { activeIndexAt, type ExtensionScope } from "../../../../src/engine/interpreter.ts";
import type { Session, SessionState } from "../../../../src/engine/session.ts";
import type { Project } from "../../../../src/engine/types.ts";
import { checkConditionContext } from "./sim.ts";

export type GoalCmpOp = "==" | "!=" | ">=" | "<=" | ">" | "<";

export type ReachGoal =
  | { kind: "switch"; id: string; value: boolean }
  | { kind: "variable"; id: string; op: GoalCmpOp; value: number }
  | { kind: "item"; id: string; op: GoalCmpOp; count: number }
  | { kind: "gold"; op: GoalCmpOp; value: number }
  | { kind: "selfSwitch"; map: string; event: string; key: string; value: boolean }
  | { kind: "eventPage"; map: string; event: string; page: number }
  | { kind: "map"; id: string; x?: number; y?: number };

export type ReachGoalExpr =
  | { op: "all" | "any"; goals: ReachGoalExpr[] }
  | ReachGoal;

export class GoalParseError extends Error {}

// --- parsing --------------------------------------------------------------------

const CMP_OPS: readonly GoalCmpOp[] = ["==", "!=", ">=", "<=", ">", "<"];

function fail(message: string): never {
  throw new GoalParseError(message);
}

function parseBool(raw: string, what: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fail(`${what} must be true or false, got ${JSON.stringify(raw)}`);
}

function parseNumber(raw: string, what: string): number {
  // Number("") is 0: an empty operand must be a parse error, not a silent
  // zero (gold>= would otherwise "prove" gold>=0 at frame 0).
  if (raw.trim().length === 0) return fail(`${what} must be a finite number, got an empty value`);
  const n = Number(raw);
  if (!Number.isFinite(n)) return fail(`${what} must be a finite number, got ${JSON.stringify(raw)}`);
  return n;
}

function parseNonNegInt(raw: string, what: string): number {
  const n = parseNumber(raw, what);
  if (!Number.isInteger(n) || n < 0) {
    return fail(`${what} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Skip ASCII whitespace, returning the new position. */
function skipWs(s: string, pos: number): number {
  while (pos < s.length) {
    const c = s[pos]!;
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") break;
    pos++;
  }
  return pos;
}

function scanDigits(s: string, pos: number): number {
  while (pos < s.length) {
    const c = s[pos]!;
    if (c < "0" || c > "9") break;
    pos++;
  }
  return pos;
}

/** Scan one atom (a goal without combinators) starting at `pos`. An atom
 *  ends at a top-level comma or closing paren (parens nest). A map
 *  coordinate `@<x>,<y>` is atomic: the comma between its two numbers is
 *  part of the atom, not a separator — only recognized when the text after
 *  `@` really is two numbers, so an `@` anywhere else is a plain character
 *  and the next comma still splits. */
function scanAtomText(s: string, pos: number): { text: string; next: number } {
  const start = pos;
  let depth = 0;
  while (pos < s.length) {
    const c = s[pos]!;
    if (c === "(") {
      depth++;
      pos++;
    } else if (c === ")") {
      if (depth === 0) break;
      depth--;
      pos++;
    } else if (c === "," && depth === 0) {
      break;
    } else if (c === "@" && depth === 0) {
      const afterAt = skipWs(s, pos + 1);
      const afterX = scanDigits(s, afterAt);
      if (afterX > afterAt) {
        const afterComma = skipWs(s, afterX);
        if (s[afterComma] === ",") {
          const afterY = skipWs(s, afterComma + 1);
          const afterYDigits = scanDigits(s, afterY);
          if (afterYDigits > afterY) {
            pos = afterYDigits;
            continue;
          }
        }
      }
      pos++;
    } else {
      pos++;
    }
  }
  return { text: s.slice(start, pos).trim(), next: pos };
}

/** Find the comparator at the first op char in `rest`; returns the op and
 *  the operand text after it, or null when no op is present. */
function splitComparator(rest: string, what: string): { op: GoalCmpOp; operand: string } | null {
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (c !== "=" && c !== "!" && c !== ">" && c !== "<") continue;
    const two = rest.slice(i, i + 2);
    const op = (CMP_OPS as readonly string[]).includes(two)
      ? (two as GoalCmpOp)
      : (CMP_OPS as readonly string[]).includes(c)
        ? (c as GoalCmpOp)
        : fail(`${what}: expected a comparator (== != >= <= > <) at ${JSON.stringify(rest.slice(i))}`);
    return { op, operand: rest.slice(i + op.length).trim() };
  }
  return null;
}

function parseSwitch(rest: string): ReachGoal {
  const eq = rest.indexOf("=");
  if (eq < 0) {
    const id = rest.trim();
    if (!id) fail(`switch: goal needs an id`);
    return { kind: "switch", id, value: true };
  }
  const id = rest.slice(0, eq).trim();
  if (!id) fail(`switch: goal needs an id`);
  return { kind: "switch", id, value: parseBool(rest.slice(eq + 1).trim(), "switch value") };
}

function parseVariable(rest: string): ReachGoal {
  const cmp = splitComparator(rest, "variable goal");
  if (!cmp) fail(`variable: goal needs a comparator, e.g. variable:count>=3`);
  const id = rest.slice(0, rest.indexOf(cmp.op)).trim();
  if (!id) fail(`variable: goal needs an id`);
  return { kind: "variable", id, op: cmp.op, value: parseNumber(cmp.operand, "variable operand") };
}

function parseItem(rest: string): ReachGoal {
  const cmp = splitComparator(rest, "item goal");
  const id = (cmp ? rest.slice(0, rest.indexOf(cmp.op)) : rest).trim();
  if (!id) fail(`item: goal needs an id`);
  if (!cmp) return { kind: "item", id, op: ">=", count: 1 };
  return { kind: "item", id, op: cmp.op, count: parseNumber(cmp.operand, "item count") };
}

function parseGold(rest: string): ReachGoal {
  const cmp = splitComparator(rest, "gold goal");
  if (!cmp) fail(`gold goal needs a comparator, e.g. gold>=80`);
  return { kind: "gold", op: cmp.op, value: parseNumber(cmp.operand, "gold operand") };
}

function parseSelfSwitch(rest: string): ReachGoal {
  const slash = rest.split("/");
  if (slash.length !== 3) {
    fail(`selfSwitch: goal needs map/event/key, got ${JSON.stringify(rest)}`);
  }
  const map = slash[0]!.trim();
  const event = slash[1]!.trim();
  let keyPart = slash[2]!.trim();
  let value = true;
  const eq = keyPart.indexOf("=");
  if (eq >= 0) {
    value = parseBool(keyPart.slice(eq + 1).trim(), "selfSwitch value");
    keyPart = keyPart.slice(0, eq).trim();
  }
  if (!map || !event || !keyPart) {
    fail(`selfSwitch: goal needs map/event/key, got ${JSON.stringify(rest)}`);
  }
  // The engine only ever holds A..D (interpreter.ts SelfKey); a lowercase or
  // out-of-range key can never hold, so accepting it would let a goal run
  // the whole budget to "prove" a miss.
  if (keyPart !== "A" && keyPart !== "B" && keyPart !== "C" && keyPart !== "D") {
    fail(`selfSwitch: key must be one of A, B, C, D, got ${JSON.stringify(keyPart)}`);
  }
  return { kind: "selfSwitch", map, event, key: keyPart, value };
}

function parseEventPage(rest: string): ReachGoal {
  const slash = rest.split("/");
  if (slash.length !== 2) fail(`event-page: goal needs map/event=page, got ${JSON.stringify(rest)}`);
  const map = slash[0]!.trim();
  const after = slash[1]!;
  const eq = after.indexOf("=");
  if (eq < 0) fail(`event-page: goal needs =<page>, got ${JSON.stringify(rest)}`);
  const event = after.slice(0, eq).trim();
  if (!map || !event) fail(`event-page: goal needs map/event=page, got ${JSON.stringify(rest)}`);
  return { kind: "eventPage", map, event, page: parseNonNegInt(after.slice(eq + 1).trim(), "event-page page") };
}

function parseMapGoal(rest: string): ReachGoal {
  const at = rest.indexOf("@");
  if (at < 0) {
    const id = rest.trim();
    if (!id) fail(`map: goal needs a map id`);
    return { kind: "map", id };
  }
  const id = rest.slice(0, at).trim();
  if (!id) fail(`map: goal needs a map id`);
  const coords = rest.slice(at + 1).split(",");
  if (coords.length !== 2) fail(`map@x,y needs two coordinates, got ${JSON.stringify(rest.slice(at + 1))}`);
  return {
    kind: "map",
    id,
    x: parseNonNegInt(coords[0]!.trim(), "map x"),
    y: parseNonNegInt(coords[1]!.trim(), "map y"),
  };
}

function parseAtom(input: string): ReachGoal {
  const s = input.trim();
  // An atom has no parens: anything with them is either an unbalanced
  // combinator (all(switch:done), any(switch:x)) or plain garbage, not a
  // switch id full of punctuation.
  if (s.includes("(") || s.includes(")")) {
    fail(`cannot parse goal ${JSON.stringify(s)}: unbalanced parentheses or unknown combinator`);
  }
  const prefix = (p: string): string | null =>
    s.startsWith(p) ? s.slice(p.length) : null;
  let rest: string | null;
  if ((rest = prefix("switch:")) !== null) return parseSwitch(rest);
  if ((rest = prefix("variable:")) !== null) return parseVariable(rest);
  if ((rest = prefix("item:")) !== null) return parseItem(rest);
  if ((rest = prefix("selfSwitch:")) !== null) return parseSelfSwitch(rest);
  if ((rest = prefix("event-page:")) !== null) return parseEventPage(rest);
  if ((rest = prefix("map:")) !== null) return parseMapGoal(rest);
  if (s.startsWith("gold")) {
    const after = s.slice(4);
    if (after.length === 0 || after[0] === "=" || after[0] === "!" || after[0] === ">" || after[0] === "<") {
      return parseGold(after);
    }
  }
  if (s.includes("@")) return parseMapGoal(s);
  return fail(
    `cannot parse goal ${JSON.stringify(s)}: expected switch:, variable:, item:, gold<op>, selfSwitch:, event-page:, map:, or all()/any()`,
  );
}

/** Parse one expression at `pos`, returning it and the position after.
 *  Combinators nest; atoms are scanned whole (a map@x,y coordinate keeps
 *  its internal comma). Unbalanced parentheses and trailing text are
 *  errors, not split quirks. */
function parseExprAt(s: string, pos: number): { expr: ReachGoalExpr; next: number } {
  pos = skipWs(s, pos);
  const combo = (op: "all" | "any"): { expr: ReachGoalExpr; next: number } | null => {
    const head = `${op}(`;
    if (!s.startsWith(head, pos)) return null;
    let p = pos + head.length;
    const goals: ReachGoalExpr[] = [];
    p = skipWs(s, p);
    if (s[p] === ")") fail(`${op}(...) needs at least one goal`);
    for (;;) {
      const inner = parseExprAt(s, p);
      goals.push(inner.expr);
      p = skipWs(s, inner.next);
      if (s[p] === ",") {
        p = skipWs(s, p + 1);
        continue;
      }
      if (s[p] === ")") {
        return { expr: { op, goals }, next: p + 1 };
      }
      fail(`expected , or ) in ${op}(...) at ${JSON.stringify(s.slice(p))}`);
    }
  };
  const all = combo("all");
  if (all) return all;
  const any = combo("any");
  if (any) return any;
  const atom = scanAtomText(s, pos);
  if (atom.text.length === 0) fail(`empty goal in ${JSON.stringify(s)}`);
  return { expr: parseAtom(atom.text), next: atom.next };
}

export function parseGoalExpr(input: string): ReachGoalExpr {
  const s = input.trim();
  if (s.length === 0) fail("empty goal");
  const { expr, next } = parseExprAt(s, 0);
  const rest = s.slice(next).trim();
  if (rest.length > 0) {
    fail(`cannot parse goal ${JSON.stringify(s)}: unexpected trailing text ${JSON.stringify(rest)}`);
  }
  return expr;
}

/** Parse a list of goal strings under a mode (default "all"). */
export function parseGoals(goals: readonly string[], mode: "all" | "any" = "all"): ReachGoalExpr {
  if (goals.length === 1) return parseGoalExpr(goals[0]!);
  return { op: mode, goals: goals.map(parseGoalExpr) };
}

/** Every leaf goal of an expression, in left-to-right order. */
export function leafGoals(expr: ReachGoalExpr): ReachGoal[] {
  if ("op" in expr && (expr.op === "all" || expr.op === "any")) {
    return expr.goals.flatMap(leafGoals);
  }
  return [expr as ReachGoal];
}

// --- evaluation -----------------------------------------------------------------

export interface GoalEvalCtx {
  state: SessionState;
  session: Session;
}

function cmp(actual: number, op: GoalCmpOp, expected: number): boolean {
  switch (op) {
    case "==": return actual === expected;
    case "!=": return actual !== expected;
    case ">=": return actual >= expected;
    case "<=": return actual <= expected;
    case ">": return actual > expected;
    case "<": return actual < expected;
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function evalGoal(goal: ReachGoal, ctx: GoalEvalCtx): boolean {
  const { state, session } = ctx;
  switch (goal.kind) {
    case "switch":
      return (hasOwn(state.sw.switches, goal.id) ? state.sw.switches[goal.id] : false) === goal.value;
    case "variable": {
      const v = hasOwn(state.sw.variables, goal.id) ? state.sw.variables[goal.id] : 0;
      return typeof v === "number" && cmp(v, goal.op, goal.value);
    }
    case "item": {
      const n = hasOwn(state.sw.items, goal.id) ? state.sw.items[goal.id] : 0;
      return typeof n === "number" && cmp(n, goal.op, goal.count);
    }
    case "gold":
      return cmp(state.sw.gold, goal.op, goal.value);
    case "selfSwitch": {
      const key = `${goal.map}/${goal.event}`;
      const held = hasOwn(state.sw.self, key) ? state.sw.self[key] : undefined;
      return (held === goal.key) === goal.value;
    }
    case "eventPage": {
      const map = session.maps.get(goal.map);
      const ev = map?.events?.find((e) => e.id === goal.event);
      if (!map || !ev) return false;
      const condCtx = checkConditionContext(state, map);
      const ext: ExtensionScope = { runtime: session.extensions, ext: state.ext };
      return activeIndexAt(ev, state.sw, `${goal.map}/${goal.event}`, state.move.facing, ext, condCtx) === goal.page;
    }
    case "map":
      if (state.mapId !== goal.id) return false;
      if (goal.x === undefined || goal.y === undefined) return true;
      return state.move.tx === goal.x && state.move.ty === goal.y;
  }
}

export function evalGoalExpr(expr: ReachGoalExpr, ctx: GoalEvalCtx): boolean {
  if ("op" in expr && (expr.op === "all" || expr.op === "any")) {
    return expr.op === "all"
      ? expr.goals.every((g) => evalGoalExpr(g, ctx))
      : expr.goals.some((g) => evalGoalExpr(g, ctx));
  }
  return evalGoal(expr as ReachGoal, ctx);
}

// --- validation against a project ------------------------------------------------

/** Validate that every map/event a goal names exists (and tiles are in
 *  bounds, page indexes in range). Returns user-facing error messages. */
export function validateGoalsAgainstProject(expr: ReachGoalExpr, project: Project): string[] {
  const errors: string[] = [];
  const mapById = new Map(project.maps.map((m) => [m.id, m]));
  const walk = (e: ReachGoalExpr): void => {
    if ("op" in e && (e.op === "all" || e.op === "any")) {
      e.goals.forEach(walk);
      return;
    }
    const g = e as ReachGoal;
    if (g.kind === "map") {
      const map = mapById.get(g.id);
      if (!map) {
        errors.push(`goal ${formatGoal(g)}: map ${JSON.stringify(g.id)} is not in the document`);
        return;
      }
      if (g.x !== undefined && g.y !== undefined && (g.x >= map.width || g.y >= map.height)) {
        errors.push(`goal ${formatGoal(g)}: tile (${g.x}, ${g.y}) is outside ${JSON.stringify(g.id)} (${map.width}x${map.height})`);
      }
    } else if (g.kind === "selfSwitch" || g.kind === "eventPage") {
      const map = mapById.get(g.map);
      if (!map) {
        errors.push(`goal ${formatGoal(g)}: map ${JSON.stringify(g.map)} is not in the document`);
        return;
      }
      const ev = map.events?.find((e2) => e2.id === g.event);
      if (!ev) {
        errors.push(`goal ${formatGoal(g)}: event ${JSON.stringify(g.event)} is not on map ${JSON.stringify(g.map)}`);
        return;
      }
      if (g.kind === "eventPage" && g.page >= ev.pages.length) {
        errors.push(`goal ${formatGoal(g)}: event ${JSON.stringify(g.event)} has only ${ev.pages.length} page(s)`);
      }
    }
  };
  walk(expr);
  return errors;
}

// --- canonical formatting ----------------------------------------------------------

export function formatGoal(goal: ReachGoal): string {
  switch (goal.kind) {
    case "switch":
      return `switch:${goal.id}=${goal.value}`;
    case "variable":
      return `variable:${goal.id}${goal.op}${goal.value}`;
    case "item":
      return goal.op === ">=" && goal.count === 1
        ? `item:${goal.id}`
        : `item:${goal.id}${goal.op}${goal.count}`;
    case "gold":
      return `gold${goal.op}${goal.value}`;
    case "selfSwitch":
      return `selfSwitch:${goal.map}/${goal.event}/${goal.key}${goal.value ? "" : "=false"}`;
    case "eventPage":
      return `event-page:${goal.map}/${goal.event}=${goal.page}`;
    case "map":
      return goal.x !== undefined && goal.y !== undefined ? `map:${goal.id}@${goal.x},${goal.y}` : `map:${goal.id}`;
  }
}

export function formatGoalExpr(expr: ReachGoalExpr): string {
  if ("op" in expr && (expr.op === "all" || expr.op === "any")) {
    return `${expr.op}(${expr.goals.map(formatGoalExpr).join(", ")})`;
  }
  return formatGoal(expr as ReachGoal);
}

// --- state summary ------------------------------------------------------------------

/** A compact, JSON-friendly summary of a state for goal reports: where the
 *  player is and every set bank entry (the records are sparse, so only keys
 *  the game wrote appear). */
export interface ReachStateSummary {
  map: string;
  x: number;
  y: number;
  facing: string;
  gold: number;
  switches: Record<string, boolean>;
  variables: Record<string, number | string>;
  items: Record<string, number>;
  selfSwitches: Record<string, string>;
}

/** Facing is numeric (0 down, 1 left, 2 up, 3 right — the engine's Facing). */
const FACING_NAMES = ["down", "left", "up", "right"] as const;

export function summarizeState(state: SessionState): ReachStateSummary {
  const selfSwitches: Record<string, string> = {};
  for (const [key, held] of Object.entries(state.sw.self)) {
    if (held !== undefined) selfSwitches[key] = held;
  }
  return {
    map: state.mapId,
    x: state.move.tx,
    y: state.move.ty,
    facing: FACING_NAMES[state.move.facing] ?? String(state.move.facing),
    gold: state.sw.gold,
    switches: { ...state.sw.switches },
    variables: { ...state.sw.variables },
    items: { ...state.sw.items },
    selfSwitches,
  };
}
