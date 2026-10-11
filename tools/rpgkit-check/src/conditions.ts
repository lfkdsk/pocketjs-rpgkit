// tools/rpgkit-check/src/conditions.ts — conservative proofs over page/if
// conditions. switch / selfSwitch / variable / appearance / tileProperty
// clauses are provable statically; item / gold / facing / worldIdle /
// bgmPlaying / vehicle / ext clauses are treated as unknown (never satisfy a
// proof, so the checks stay sound).

import type { AppearanceTarget, Condition, Dir, PageCondition } from "../../../src/engine/types.ts";
import type { SelfKey } from "../../../src/engine/interpreter.ts";

/** Flatten a page condition (flat fields ANDed with `all`) into the
 *  Condition list the engine evaluates. */
export function flattenPageCondition(condition: PageCondition | undefined): Condition[] {
  if (!condition) return [];
  const out: Condition[] = [...(condition.all ?? [])];
  if (condition.switch !== undefined) out.push({ kind: "switch", id: condition.switch, value: true });
  if (condition.variable !== undefined) out.push({ kind: "variable", ...condition.variable });
  if (condition.selfSwitch !== undefined) {
    out.push({ kind: "selfSwitch", key: condition.selfSwitch, value: true });
  }
  if (condition.item !== undefined) out.push({ kind: "item", id: condition.item, count: 1 });
  return out;
}

interface VarConstraint {
  lo: number; // -Infinity = unbounded
  hi: number; // +Infinity = unbounded
  eq: Set<number>;
  neq: Set<number>;
}

function freshVar(): VarConstraint {
  return { lo: -Infinity, hi: Infinity, eq: new Set(), neq: new Set() };
}

function varContradiction(c: VarConstraint): boolean {
  if (c.lo > c.hi) return true;
  if (c.eq.size > 1) return true;
  for (const v of c.eq) {
    if (v < c.lo || v > c.hi || c.neq.has(v)) return true;
  }
  // A finite range fully covered by != clauses is empty.
  if (Number.isFinite(c.lo) && Number.isFinite(c.hi) && c.hi - c.lo + 1 <= c.neq.size) {
    let covered = true;
    for (let v = c.lo; v <= c.hi; v++) {
      if (!c.neq.has(v)) {
        covered = false;
        break;
      }
    }
    if (covered) return true;
  }
  return false;
}

// Mirrors interpreter.ts dirMask: the engine matches an enter/exit override
// iff its dir mask EQUALS the clause's mask, so two lists are compatible iff
// their masks are equal.
const DIR_BITS: Record<Dir, number> = { down: 1, left: 2, up: 4, right: 8 };

function dirMask(dirs: readonly Dir[]): number {
  let mask = 0;
  for (const dir of dirs) mask |= DIR_BITS[dir];
  return mask;
}

/** Normalize an appearance condition's target to a stable key. "player" is
 *  one character; {event:"x"} is the map event "x"; "this" is its own key
 *  (it cannot be normalized without the running event's context). The
 *  prefixes keep the three classes collision-free even if an event is
 *  literally named "player" or "this". */
function appearanceTargetKey(target: AppearanceTarget): string {
  if (target === "player") return ":player";
  if (target === "this") return ":this";
  return `e:${target.event}`;
}

type TileFieldExpectation = "pass" | "block" | null;
type DirFieldExpectation = Dir[] | null;

interface TileCellExpectations {
  passage?: TileFieldExpectation;
  enter?: DirFieldExpectation;
  exit?: DirFieldExpectation;
}

/** Two expectations on the same tileProperty field are incompatible when one
 *  is null and the other is not, or both are non-null and differ. For
 *  passage "pass" vs "block" differ; for enter/exit the engine matches iff
 *  the override's dir mask equals the clause's mask, so two lists are
 *  compatible iff their masks are equal. */
function tilePassageIncompatible(a: TileFieldExpectation, b: TileFieldExpectation): boolean {
  return a !== b;
}

function tileDirsIncompatible(a: DirFieldExpectation, b: DirFieldExpectation): boolean {
  if (a === null || b === null) return a !== b;
  return dirMask(a) !== dirMask(b);
}

/** True when the conjunction is provably false: a switch/selfSwitch
 *  demanded both values, two DISTINCT self switches both demanded true (an
 *  event holds only one self key, so A=true and B=true cannot hold together),
 *  a variable with an empty feasible set, two appearance clauses on the same
 *  target demanding different sprites (a character has ONE effective sprite
 *  key), or two tileProperty clauses on the same cell with incompatible field
 *  expectations. A=true and B=false stays satisfiable (self=A), so it is not
 *  flagged. Same-target/same-sprite and same-cell/same-expectation pairs are
 *  redundant, not contradictory. */
export function conditionContradiction(conditions: readonly Condition[]): boolean {
  const switches = new Map<string, boolean>();
  const self = new Map<SelfKey, boolean>();
  const selfTrue = new Set<SelfKey>();
  const vars = new Map<string, VarConstraint>();
  const appearanceSprites = new Map<string, string | null>();
  const tileCells = new Map<string, TileCellExpectations>();
  for (const c of conditions) {
    if (c.kind === "switch") {
      const want = c.value ?? true;
      const prev = switches.get(c.id);
      if (prev !== undefined && prev !== want) return true;
      switches.set(c.id, want);
    } else if (c.kind === "selfSwitch") {
      const want = c.value ?? true;
      const prev = self.get(c.key);
      if (prev !== undefined && prev !== want) return true;
      self.set(c.key, want);
      if (want) {
        selfTrue.add(c.key);
        if (selfTrue.size > 1) return true;
      }
    } else if (c.kind === "variable") {
      const v = vars.get(c.id) ?? freshVar();
      if (c.op === ">=") v.lo = Math.max(v.lo, c.value);
      else if (c.op === "<=") v.hi = Math.min(v.hi, c.value);
      else if (c.op === "==") v.eq.add(c.value);
      else v.neq.add(c.value);
      if (varContradiction(v)) return true;
      vars.set(c.id, v);
    } else if (c.kind === "appearance") {
      const key = appearanceTargetKey(c.target);
      const prev = appearanceSprites.get(key);
      if (prev !== undefined && prev !== c.sprite) return true;
      appearanceSprites.set(key, c.sprite);
    } else if (c.kind === "tileProperty") {
      const key = `${c.x},${c.y}`;
      const cell = tileCells.get(key) ?? {};
      if (c.passage !== undefined) {
        if (cell.passage !== undefined && tilePassageIncompatible(cell.passage, c.passage)) return true;
        cell.passage = c.passage;
      }
      if (c.enter !== undefined) {
        if (cell.enter !== undefined && tileDirsIncompatible(cell.enter, c.enter)) return true;
        cell.enter = c.enter;
      }
      if (c.exit !== undefined) {
        if (cell.exit !== undefined && tileDirsIncompatible(cell.exit, c.exit)) return true;
        cell.exit = c.exit;
      }
      tileCells.set(key, cell);
    }
    // item / gold / facing / worldIdle / bgmPlaying / vehicle / ext: not
    // statically provable.
  }
  return false;
}

function varImplies(stronger: VarConstraint | undefined, weaker: Condition): boolean {
  if (!stronger) return false;
  if (weaker.kind !== "variable") return false;
  if (weaker.op === ">=") {
    if (stronger.eq.size) return [...stronger.eq].every((v) => v >= weaker.value);
    return Number.isFinite(stronger.lo) && stronger.lo >= weaker.value;
  }
  if (weaker.op === "<=") {
    if (stronger.eq.size) return [...stronger.eq].every((v) => v <= weaker.value);
    return Number.isFinite(stronger.hi) && stronger.hi <= weaker.value;
  }
  if (weaker.op === "==") return stronger.eq.has(weaker.value);
  // !=
  if (stronger.eq.size) return [...stronger.eq].every((v) => v !== weaker.value);
  return stronger.lo > weaker.value || stronger.hi < weaker.value;
}

/** Conservative implication: does `stronger` holding guarantee `weaker`
 *  holds? Unknown clause kinds in `weaker` make it false (sound). Used to
 *  prove earlier pages dead: a later page whose condition is implied by an
 *  earlier page's condition always wins page selection over it. */
export function conditionImplies(
  stronger: readonly Condition[],
  weaker: readonly Condition[],
): boolean {
  const sSwitches = new Map<string, boolean>();
  const sSelf = new Map<SelfKey, boolean>();
  const sVars = new Map<string, VarConstraint>();
  for (const c of stronger) {
    if (c.kind === "switch") sSwitches.set(c.id, c.value ?? true);
    else if (c.kind === "selfSwitch") sSelf.set(c.key, c.value ?? true);
    else if (c.kind === "variable") {
      const v = sVars.get(c.id) ?? freshVar();
      if (c.op === ">=") v.lo = Math.max(v.lo, c.value);
      else if (c.op === "<=") v.hi = Math.min(v.hi, c.value);
      else if (c.op === "==") v.eq.add(c.value);
      else v.neq.add(c.value);
      sVars.set(c.id, v);
    }
  }
  for (const w of weaker) {
    if (w.kind === "switch") {
      if (sSwitches.get(w.id) !== (w.value ?? true)) return false;
    } else if (w.kind === "selfSwitch") {
      if (sSelf.get(w.key) !== (w.value ?? true)) return false;
    } else if (w.kind === "variable") {
      if (!varImplies(sVars.get(w.id), w)) return false;
    } else {
      // item / gold / facing / worldIdle / bgmPlaying / vehicle / ext in the
      // weaker side: the implication is not provable.
      return false;
    }
  }
  return true;
}
