// tools/rpgkit-check/src/dynamic/reach.ts — map reachability by real-engine
// search with replayable witnesses.
//
// "Reached" means a WITNESS exists: a button-mask tape from a fresh game
// that the tool itself replays in a brand-new session, verifying the replay
// really lands on the map with the recorded state. "notFound" means the
// search spent its budgets (frames / states / wall clock) without finding
// one — a lead with frontier statistics, never a proof of unreachability.
//
// The search is a breadth-first graph over real engine states:
//
//   - a node is a world-idle SessionState (deep-cloned, so branches restore
//     a snapshot instead of replaying a prefix);
//   - an edge is a MACRO (reach-driver.ts): walk to a triggerable event on
//     the engine's own passage table, fire it, and ride out dialogs, shops,
//     battles and transfers until the world is idle again. A choices box
//     branches — every option is its own edge;
//   - a wait macro stands still sampling active pages, so a page a parallel
//     activates on a timer is caught and targeted;
//   - states dedupe on the engine's canonical state fingerprint (the
//     save-snapshot payload with between-fold transients dropped and pure
//     progress — frame clock, audio positions, sub-tile movement — zeroed,
//     and every absolute time anchor rebased onto the zeroed clock, so
//     persistent audio intent, fibers, latches and every other
//     condition-relevant field are in the key automatically).
//
// Structural transfer checks (missing target, blocked landing, orphan maps,
// dynamic-target transfers) are deterministic proofs and live in
// reach-static.ts. The old frozen-variable / fixed-tick / command-tree
// interpreter is gone: there is no second model of the engine to disagree
// with it.

import type { BattleInput, BattleRules } from "../../../../src/engine/battle.ts";
import { activePage, type ExtensionScope } from "../../../../src/engine/interpreter.ts";
import { deepClone } from "../../../../src/engine/clone.ts";
import { isStandable } from "../../../../src/engine/passability.ts";
import {
  createSession,
  sessionPassageTable,
  stepSession,
  tableWithBodies,
  type Session,
  type SessionInput,
  type SessionOptions,
  type SessionState,
} from "../../../../src/engine/session.ts";
import type { Dir, Project } from "../../../../src/engine/types.ts";
import { makeFinding, type CheckReport, type Finding, type FindingLocation } from "../finding.ts";
import {
  CHECK_HZ,
  checkSessionOptions,
  NOOP_BATTLE_RULES,
  checkConditionContext,
  projectWithStart,
  reachStartSwitchState,
  startFresh,
} from "./sim.ts";
import {
  executeMacro,
  executeWait,
  planTargets,
  type MacroContext,
  type MacroLeaf,
  type TransientSnapshot,
} from "./reach-driver.ts";
import { staticTransferChecks } from "./reach-static.ts";
import {
  replayWitness,
  stateHash,
  stateKey,
  verifyWitness,
  type ReachWitness,
} from "./reach-witness.ts";
import {
  evalGoal,
  evalGoalExpr,
  formatGoal,
  formatGoalExpr,
  leafGoals,
  parseGoals,
  summarizeState,
  validateGoalsAgainstProject,
  type ReachGoal,
  type ReachGoalExpr,
  type ReachStateSummary,
} from "./reach-goal.ts";

/** The search limitations every verdict is reported under. */
const REACH_ASSUMPTIONS: readonly string[] = [
  "a \"notFound\" verdict means the search spent its budgets without finding a replayable witness — a lead, not a proof; puzzles, shops, extension logic, dynamic-target transfers and battle outcomes under non-default rules may still reach the map",
  "shops are dismissed (cancel), not used to buy or sell: a map gated on a shop purchase is notFound",
  "transfers with a dynamic (variable) target map are not followed (they are listed as reach/dynamic-transfer info findings)",
  "extension (ext) commands and conditions run under allowUnknown no-op semantics; extension choice options are not branched",
  "battles under the default policy are declined (no encounter, no result branch); under registered rules the battle auto-input is zero-input and a battle that never completes dead-ends",
  "the state dedup key is the engine's canonical state fingerprint (the save-snapshot payload — map, player, the full interpreter state, ext — with between-fold transients dropped and pure progress zeroed: the absolute frame clock, audio playback positions, and the mover's sub-tile interpolation kept at tile+facing; every absolute time anchor is rebased onto the zeroed clock, so same elapsed time merges and different elapsed time splits); two states equal on the key are merged, which can only leave a map unfound, never fabricate a witness",
  "witnesses are 60 Hz tapes recorded in constant 6-tick blocks (pressed edges on block boundaries); each witness is replayed and verified at 60 Hz in a fresh session — the tool makes no claim about other host frame rates",
  "moving characters step under the real engine during a macro; a path blocked by a wandering body aborts that macro (the search may retry from another state)",
];

function reachAssumptions(sessionOptions?: SessionOptions): string[] {
  if (!sessionOptions?.extensions) return [...REACH_ASSUMPTIONS];
  return REACH_ASSUMPTIONS.map((assumption) => assumption.startsWith("extension (ext)")
    ? "registered extension commands and conditions run under the loaded session module; unknown extensions follow its allowUnknown policy (true by default); extension choice options are not branched"
    : assumption);
}

const ZERO_INPUT: SessionInput = {
  buttons: 0,
  confirmEdge: false,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
};

export interface ReachOptions {
  /** Where the search starts, with the initial story bank. Defaults to the
   *  project's own start. */
  start?: {
    map: string;
    x: number;
    y: number;
    dir?: Dir;
    switches?: Record<string, boolean>;
    variables?: Record<string, number>;
    items?: Record<string, number>;
    gold?: number;
  };
  /** Total engine tick budget for the whole search (default 120000). */
  maxFrames?: number;
  /** Max nodes expanded (default 3000). */
  maxStates?: number;
  /** Wall-clock budget in seconds (default 60). A safety valve only: when it
   *  fires the run is marked time-budget and results may vary under load;
   *  the frame/state budgets are deterministic. */
  maxSeconds?: number;
  /** Battle policy. Default: encounters are declined (the engine resumes the
   *  fiber with no result branch). Supply registered rules to fight battles
   *  for real, with an optional per-frame auto-input. */
  battle?: {
    rules: BattleRules;
    input?: (state: unknown) => BattleInput;
  };
  /** State goals: predicate strings (reach-goal.ts grammar). With goals,
   *  the search stops as soon as the combined predicate holds at one
   *  observed state ("goals-met") and reports the witness to that state;
   *  without goals the implicit goal is every map and the search stops as
   *  soon as every map has a witness. */
  goals?: string[];
  /** How multiple goals combine (default "all"). */
  goalMode?: "all" | "any";
  /** Game-owned registrations loaded by the CLI's --session module. */
  sessionOptions?: SessionOptions;
}

export interface ReachInboundRef {
  source: string;
  loc: FindingLocation;
  /** What the search observed about the source page. */
  state: "triggered" | "observed-active" | "never-active" | "dynamic";
}

export interface ReachFrontier {
  /** Static transfers (and dynamic-target transfers) that name this map. */
  inbound: ReachInboundRef[];
}

export type ReachMapResult =
  | {
      map: string;
      status: "reached";
      /** Witness length in ticks. */
      frames: number;
      witness: ReachWitness;
      /** stateHash of the recorded arrival state. */
      stateHash: string;
    }
  | {
      map: string;
      status: "notFound";
      frontier: ReachFrontier;
    };

/** One leaf goal's outcome, with its own replayable witness when met. */
export interface ReachGoalResult {
  goal: string;
  status: "met" | "unmet";
  witness?: ReachWitness;
  final?: ReachStateSummary;
}

/** The explored state that satisfied the most goals, with a replayable
 *  witness, so a budget-exhausted run still shows how far the search got. */
export interface ReachClosest {
  final: ReachStateSummary;
  satisfied: string[];
  unsatisfied: string[];
  frames: number;
  witness?: ReachWitness;
}

export interface ReachGoalsReport {
  mode: "all" | "any";
  status: "met" | "unmet";
  /** The canonical goal expression (formatGoalExpr) the search evaluated —
   *  the faithful source for a replay, which evaluates it with the same
   *  any/all/nested semantics. `mode`/`results` are the display view. */
  expr: string;
  results: ReachGoalResult[];
  /** The witness that satisfied the combined predicate (status "met"). */
  witness?: ReachWitness;
  expectedHash?: string;
  final?: ReachStateSummary;
  /** The start the search ran from, when it was not the project start, so a
   *  replay can reconstruct the same origin (map, position, bank). */
  start?: {
    map: string;
    x: number;
    y: number;
    dir?: string;
    switches?: Record<string, boolean>;
    variables?: Record<string, number>;
    items?: Record<string, number>;
    gold?: number;
  };
  /** The closest state when the goals were not all met. */
  closest?: ReachClosest;
  /** When a budget stopped the search before the goals were met: a larger
   *  budget worth retrying with (a heuristic, not a promise). */
  suggestedBudget?: { maxFrames?: number; maxStates?: number; maxSeconds?: number };
}

export interface ReachReport extends CheckReport {
  check: "reach";
  findings: Finding[];
  start: string;
  battlePolicy: "encounters-declined" | "registered-rules";
  endedReason: "exhausted" | "frame-budget" | "state-budget" | "time-budget" | "goals-met";
  budgets: { maxFrames: number; maxStates: number; maxSeconds: number };
  maps: ReachMapResult[];
  /** Convenience: maps with a replayed witness, in document order. */
  reachableMaps: string[];
  /** Convenience: maps no witness was found for, in document order. */
  notFoundMaps: string[];
  /** Present when the run had explicit state goals. */
  goals?: ReachGoalsReport;
  /** When a NO-GOAL run stopped on a budget with maps still unfound: the
   *  deepest explored state (the farthest story progress the search made),
   *  with its own replayable witness — the same lead the goals section's
   *  `closest` gives a goals run. `expectedHash` and `start` let a fresh
   *  `reach --replay` re-verify the lead from the same origin. */
  closest?: {
    final: ReachStateSummary;
    depth: number;
    frames: number;
    witness: ReachWitness;
    expectedHash?: string;
    start?: {
      map: string;
      x: number;
      y: number;
      dir?: string;
      switches?: Record<string, boolean>;
      variables?: Record<string, number>;
      items?: Record<string, number>;
      gold?: number;
    };
  };
  /** When a NO-GOAL run stopped on a budget with maps still unfound: a
   *  larger budget worth retrying with (a heuristic, not a promise). */
  suggestedBudget?: { maxFrames?: number; maxStates?: number; maxSeconds?: number };
  assumptions: string[];
}

// --- priority queue -------------------------------------------------------------

interface SearchNode {
  state: SessionState;
  key: string;
  stateHash: string;
  parent: SearchNode | null;
  tapeSuffix: number[];
  /** Button mask this node's tape suffix ends with (inherited from the
   *  parent when the suffix is empty), so the next macro derives edges
   *  against the same mask a continuous replay carries across the join. */
  endMask: number;
  depth: number;
  isWait: boolean;
  seq: number;
}

/** BFS by depth; wait-macro children go last; among same-depth nodes, prefer
 *  a map that still has an observed-active page nobody triggered. Ties break
 *  by enqueue order, so the search is deterministic. */
class NodeQueue {
  private heap: SearchNode[] = [];

  constructor(private readonly mapScore: (mapId: string) => number) {}

  get size(): number {
    return this.heap.length;
  }

  push(node: SearchNode): void {
    this.heap.push(node);
    this.up(this.heap.length - 1);
  }

  pop(): SearchNode | undefined {
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.down(0);
    }
    return top;
  }

  private less(a: SearchNode, b: SearchNode): boolean {
    if (a.depth !== b.depth) return a.depth < b.depth;
    if (a.isWait !== b.isWait) return a.isWait ? false : true;
    const sa = this.mapScore(a.state.mapId);
    const sb = this.mapScore(b.state.mapId);
    if (sa !== sb) return sa < sb;
    return a.seq < b.seq;
  }

  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(this.heap[i]!, this.heap[p]!)) break;
      [this.heap[i], this.heap[p]] = [this.heap[p]!, this.heap[i]!];
      i = p;
    }
  }

  private down(i: number): void {
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < this.heap.length && this.less(this.heap[l]!, this.heap[m]!)) m = l;
      if (r < this.heap.length && this.less(this.heap[r]!, this.heap[m]!)) m = r;
      if (m === i) break;
      [this.heap[i], this.heap[m]] = [this.heap[m]!, this.heap[i]!];
      i = m;
    }
  }
}

// --- search ---------------------------------------------------------------------

/** The button mask a tape suffix ends with — the mask the next macro's
 *  driver must derive its first edges against. An empty suffix inherits the
 *  parent's ending mask, so the join matches a continuous replay. */
function endingMask(suffix: readonly number[], inherited: number): number {
  return suffix.length > 0 ? suffix[suffix.length - 1]! >>> 0 : inherited;
}

const DEFAULT_MAX_FRAMES = 120_000;
const DEFAULT_MAX_STATES = 3_000;
const DEFAULT_MAX_SECONDS = 60;

export function checkReach(project: Project, options: ReachOptions = {}): ReachReport {
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  const maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
  const maxSeconds = options.maxSeconds ?? DEFAULT_MAX_SECONDS;
  const sessionDefaults = checkSessionOptions(project, options.sessionOptions);
  const battleRules = options.battle?.rules ?? sessionDefaults.battle ?? NOOP_BATTLE_RULES;
  const battlePolicy: ReachReport["battlePolicy"] = options.battle || options.sessionOptions?.battle
    ? "registered-rules"
    : "encounters-declined";

  const start = options.start ?? {
    map: project.start.map,
    x: project.start.x,
    y: project.start.y,
    dir: project.start.dir,
  };
  const startMapDef = project.maps.find((m) => m.id === start.map);
  const proj = startMapDef
    ? projectWithStart(project, start.map, start.x, start.y, start.dir ?? project.start.dir)
    : project;

  // Fiber-start trace: which (event,page) actually ran, for the frontier.
  const triggeredPages = new Set<string>();

  // The search records and verifies witnesses at the 60 Hz reference: the
  // engine folds MOTION_HZ/hz ticks per host frame, and the tool makes no
  // claim about other host frame rates.
  const projectSessionOptions = checkSessionOptions(proj, options.sessionOptions);
  const externalFiberStart = projectSessionOptions.onFiberStart;
  const session: Session = createSession(proj, CHECK_HZ, {
    ...projectSessionOptions,
    battle: battleRules,
    onFiberStart: (key: string, pageIndex: number, parallel: boolean): void => {
      externalFiberStart?.(key, pageIndex, parallel);
      triggeredPages.add(`${key}#${pageIndex}`);
    },
  });
  // The search and a witness replay build the custom start's bank from the
  // same helper (sim.ts reachStartSwitchState), so a recorded witness always
  // replays from the same origin state.
  const sw0 = reachStartSwitchState(project, options.start);

  const findings: Finding[] = [];

  // Structural transfer proofs (always run, deterministic).
  findings.push(...staticTransferChecks(proj, session));

  if (!startMapDef) {
    findings.push(makeFinding(
      "reach/start-unreachable",
      "error",
      `start map ${JSON.stringify(start.map)} is not in the document`,
      "fix start.map",
      { map: start.map },
    ));
    return emptyReport(
      proj,
      findings,
      start,
      battlePolicy,
      maxFrames,
      maxStates,
      maxSeconds,
      options.sessionOptions,
    );
  }

  // State goals. A grammar error is a usage error (the registry wraps it as
  // a CheckArgsError); a goal that names a map/event the document does not
  // have is an error finding with an early return, the same shape as a bad
  // start.
  const goalMode: "all" | "any" = options.goalMode === "any" ? "any" : "all";
  const goalExpr: ReachGoalExpr | undefined = options.goals && options.goals.length > 0
    ? parseGoals(options.goals, goalMode)
    : undefined;
  const goalLeaves: ReachGoal[] = goalExpr ? leafGoals(goalExpr) : [];
  if (goalExpr) {
    const goalErrors = validateGoalsAgainstProject(goalExpr, proj);
    if (goalErrors.length > 0) {
      for (const message of goalErrors) {
        findings.push(makeFinding("reach/goal-unknown-target", "error", message, "fix the goal expression", {}));
      }
      return emptyReport(
        proj,
        findings,
        start,
        battlePolicy,
        maxFrames,
        maxStates,
        maxSeconds,
        options.sessionOptions,
        goalExpr,
        goalMode,
      );
    }
  }

  // --- BFS over real engine states ---------------------------------------

  const rootState = startFresh(proj, session, sw0);
  const root: SearchNode = {
    state: rootState,
    key: stateKey(rootState),
    stateHash: stateHash(rootState),
    parent: null,
    tapeSuffix: [],
    endMask: 0,
    depth: 0,
    isWait: false,
    seq: 0,
  };

  // The start tile must be standable (terrain plus the entry-time character
  // bodies, which spawn on the first tick). The engine itself does not
  // refuse a non-standable start, so the player would be stuck; flag it.
  // A one-tick probe lets the entry pages spawn their chars without running
  // the search from a mutated state.
  const probe = stepSession(session, deepClone(rootState), ZERO_INPUT);
  if (probe.mapId === start.map) {
    const startTable = tableWithBodies(sessionPassageTable(session, probe), probe.chars);
    if (!isStandable(startTable, start.x, start.y)) {
      findings.push(makeFinding(
        "reach/start-unreachable",
        "error",
        `start tile (${start.x}, ${start.y}) is not standable on map ${JSON.stringify(start.map)}`,
        "the start tile is not standable; move the start to a standable tile",
        { map: start.map },
      ));
    }
  }

  /** Pages observed active at a node (or transiently), per map. */
  const mapObservedPages = new Map<string, Set<string>>();
  const observedPages = new Set<string>();
  const observePage = (mapId: string, pageKey: string): void => {
    if (observedPages.has(pageKey)) return;
    observedPages.add(pageKey);
    let set = mapObservedPages.get(mapId);
    if (!set) {
      set = new Set();
      mapObservedPages.set(mapId, set);
    }
    set.add(pageKey);
  };
  const mapScore = (mapId: string): number => {
    const set = mapObservedPages.get(mapId);
    if (!set) return 1;
    for (const pageKey of set) if (!triggeredPages.has(pageKey)) return 0;
    return 1;
  };

  // --- goal tracking ------------------------------------------------------
  // Every observed state (the root, every node, and every mid-ride tick the
  // driver's hook reports) is considered against the goals: the first state
  // that satisfies the whole expression ends the search ("goals-met"); the
  // state with the most leaf goals satisfied is kept as the closest state
  // for a budget-exhausted run.

  /** A recorded state: the node it branched from (null = the root), the tape
   *  suffix from that node, and the recorded state hash. */
  interface GoalHit {
    parent: SearchNode | null;
    suffix: number[];
    hash: string;
    state: SessionState;
    depth: number;
  }
  const leafHits: (GoalHit | undefined)[] = goalLeaves.map(() => undefined);
  let combinedHit: GoalHit | undefined;
  let best: { hit: GoalHit; satisfied: boolean[]; count: number } | undefined;
  let goalsMet = false;

  const consider = (state: SessionState, parent: SearchNode | null, suffix: readonly number[]): void => {
    if (!goalExpr) return;
    const ctx = { state, session };
    const satisfied = goalLeaves.map((g) => evalGoal(g, ctx));
    const count = satisfied.reduce<number>((acc, ok) => acc + (ok ? 1 : 0), 0);
    const depth = (parent?.depth ?? -1) + 1;
    satisfied.forEach((ok, i) => {
      if (ok && !leafHits[i]) {
        leafHits[i] = { parent, suffix: [...suffix], hash: stateHash(state), state: deepClone(state), depth };
      }
    });
    // Strict improvement only: the closest state is the one that satisfied
    // the most goals (first one at that count), so a budget-exhausted run
    // clones at most one state per leaf goal.
    if (!best || count > best.count) {
      best = {
        hit: { parent, suffix: [...suffix], hash: stateHash(state), state: deepClone(state), depth },
        satisfied,
        count,
      };
    }
    if (!combinedHit && evalGoalExpr(goalExpr, ctx)) {
      combinedHit = { parent, suffix: [...suffix], hash: stateHash(state), state: deepClone(state), depth };
      goalsMet = true;
    }
  };

  consider(rootState, null, []);

  const queue = new NodeQueue(mapScore);
  queue.push(root);
  const seen = new Set<string>([root.key]);
  /** How each map was first reached: a node (idle state) or a mid-ride-out
   *  entry (the tape truncated at the entry pair). */
  type ReachRecord =
    | { kind: "node"; node: SearchNode }
    | { kind: "entry"; parent: SearchNode; suffix: number[]; hash: string };
  const reached = new Map<string, ReachRecord>([[rootState.mapId, { kind: "node", node: root }]]);
  let seq = 1;
  let statesExplored = 0;
  let framesRun = 0;
  let endedReason: ReachReport["endedReason"] = "exhausted";
  const t0 = Date.now();
  // The deepest explored node (macros from the root): the farthest story
  // progress the search made, reported as the closest state when a no-goal
  // run stops on a budget with maps still unfound.
  let deepest: SearchNode = root;

  /** Sample the active page of every event on the node's map, so the
   *  frontier can distinguish "condition never held" from "never confirmed". */
  const sampleNodePages = (state: SessionState): void => {
    const map = session.maps.get(state.mapId);
    if (!map) return;
    const ctx = checkConditionContext(state, map);
    const ext: ExtensionScope = { runtime: session.extensions, ext: state.ext };
    for (const ev of map.events ?? []) {
      const active = activePage(ev, state.sw, state.mapId, state.move.facing, ext, ctx);
      if (active) observePage(state.mapId, `${state.mapId}/${ev.id}#${active.index}`);
    }
  };

  /** Record a map first reached by passing through it mid-ride-out. */
  const addMapEntry = (entry: { map: string; suffix: number[]; stateHash: string }, parent: SearchNode): void => {
    if (reached.has(entry.map)) return;
    reached.set(entry.map, { kind: "entry", parent, suffix: entry.suffix, hash: entry.stateHash });
  };

  const addLeaf = (leaf: MacroLeaf, parent: SearchNode, isWait: boolean): void => {
    if (leaf.error || leaf.battleTimeout || leaf.rideBudget || leaf.budget) return; // dead end
    consider(leaf.state, parent, leaf.tapeSuffix);
    for (const pageKey of leaf.pagesObserved) {
      observePage(leaf.state.mapId, pageKey);
    }
    for (const entry of leaf.mapEntries) addMapEntry(entry, parent);
    const key = stateKey(leaf.state);
    if (seen.has(key)) return;
    seen.add(key);
    const node: SearchNode = {
      state: leaf.state,
      key,
      stateHash: stateHash(leaf.state),
      parent,
      tapeSuffix: leaf.tapeSuffix,
      endMask: endingMask(leaf.tapeSuffix, parent.endMask),
      depth: parent.depth + Math.ceil(leaf.tapeSuffix.length / 2),
      isWait,
      seq: seq++,
    };
    if (!reached.has(leaf.state.mapId)) reached.set(leaf.state.mapId, { kind: "node", node });
    if (node.depth > deepest.depth) deepest = node;
    queue.push(node);
  };

  const addSnapshot = (snap: TransientSnapshot, parent: SearchNode): void => {
    consider(snap.state, parent, snap.tapeSuffix);
    observePage(snap.state.mapId, snap.pageKey);
    const key = stateKey(snap.state);
    if (seen.has(key)) return;
    seen.add(key);
    const node: SearchNode = {
      state: snap.state,
      key,
      stateHash: stateHash(snap.state),
      parent,
      tapeSuffix: snap.tapeSuffix,
      endMask: endingMask(snap.tapeSuffix, parent.endMask),
      depth: parent.depth + Math.ceil(snap.tapeSuffix.length / 2),
      isWait: false,
      seq: seq++,
    };
    if (!reached.has(snap.state.mapId)) reached.set(snap.state.mapId, { kind: "node", node });
    if (node.depth > deepest.depth) deepest = node;
    queue.push(node);
  };

  const makeCtx = (node: SearchNode): MacroContext => ({
    battleInput: options.battle?.input as MacroContext["battleInput"],
    knownPages: observedPages,
    onTransient: (snap) => addSnapshot(snap, node),
    // State goals: every observed tick is considered; a met expression parks
    // the macro at the witnessing tick.
    onGoalHit: goalExpr
      ? (state, suffix) => {
          consider(state, node, suffix);
          return goalsMet;
        }
      : undefined,
    // Live remaining frame budget (the search updates framesRun between
    // macros) and the wall-clock deadline, so a macro parks inside its own
    // ride-out/battle/wait loop instead of a full macro past the limit.
    framesLeft: () => maxFrames - framesRun,
    deadline: t0 + maxSeconds * 1000,
  });

  // The goal checks run before the queue-empty check: a macro that meets the
  // goals parks without producing a leaf, so the queue can be empty while
  // goalsMet is set.
  for (;;) {
    if (goalsMet) {
      endedReason = "goals-met";
      break;
    }
    // With no explicit goals the implicit goal is every map: stop as soon as
    // each one has a witness instead of spending the rest of the budget
    // re-exploring (the old run-to-budget behavior).
    if (!goalExpr && reached.size >= proj.maps.length) {
      endedReason = "goals-met";
      break;
    }
    if (queue.size === 0) break;
    if (framesRun >= maxFrames) {
      endedReason = "frame-budget";
      break;
    }
    if (statesExplored >= maxStates) {
      endedReason = "state-budget";
      break;
    }
    if (Date.now() - t0 > maxSeconds * 1000) {
      endedReason = "time-budget";
      break;
    }
    const node = queue.pop()!;
    statesExplored++;
    sampleNodePages(node.state);

    const ctx = makeCtx(node);

    // Target macros: one per triggerable active page. The macro reports the
    // REAL ticks it executed (branches restore snapshots and re-run, so the
    // spend is measured per executed block): a choices fan-out's shared
    // prefix is charged once, not once per leaf. Charging leaf tape lengths
    // instead would re-charge the shared walk/dialog/cursor prefix for every
    // branch and exhaust the frame budget before the real work is done.
    const targets = planTargets(proj, session, node.state);
    for (const target of targets) {
      observePage(node.state.mapId, `${target.eventKey}#${target.activePage}`);
      const { leaves, framesSpent } = executeMacro(session, node.state, target, ctx, node.endMask);
      framesRun += framesSpent;
      for (const leaf of leaves) addLeaf(leaf, node, false);
    }

    // Wait macro: ride out entry autoruns and catch pages a parallel
    // activates on a timer. Cheap (one pair) on maps without parallels.
    {
      const { leaves, framesSpent } = executeWait(session, node.state, ctx, node.endMask);
      framesRun += framesSpent;
      for (const leaf of leaves) addLeaf(leaf, node, true);
    }
  }

  // A budget park pushes a dead-end leaf (no node), so the queue can empty
  // on a budget hit without the loop-top check running again. Classify the
  // end by the budget that was actually spent.
  if (endedReason === "exhausted") {
    if (framesRun >= maxFrames) endedReason = "frame-budget";
    else if (statesExplored >= maxStates) endedReason = "state-budget";
    else if (Date.now() - t0 > maxSeconds * 1000) endedReason = "time-budget";
  }

  // A goal hit mid-macro can land on a map the driver never reported as a
  // map entry: the witness to that state IS a witness to the map (it replays
  // there with the recorded hash), so count it as reached — the report must
  // not prove a goal on a map it also lists as notFound.
  if (combinedHit && !reached.has(combinedHit.state.mapId)) {
    reached.set(combinedHit.state.mapId, {
      kind: "entry",
      parent: combinedHit.parent ?? root,
      suffix: combinedHit.suffix,
      hash: combinedHit.hash,
    });
  }

  // --- witness verification ----------------------------------------------
  // Every "reached" map gets its tape replayed in a FRESH 60 Hz session;
  // only a replay that lands on the map with the recorded state counts.
  // The witness is verified at 60 Hz only — the tool makes no claim about
  // other host frame rates.

  const verifySession: Session = createSession(proj, CHECK_HZ, {
    ...projectSessionOptions,
    battle: battleRules,
  });
  const materialize = (node: SearchNode): ReachWitness => {
    const masks: number[] = [];
    let cur: SearchNode | null = node;
    while (cur && cur.parent) {
      masks.unshift(...cur.tapeSuffix);
      cur = cur.parent;
    }
    return { hz: CHECK_HZ as 60, masks };
  };

  const maps: ReachMapResult[] = [];
  const reachableMaps: string[] = [];
  const notFoundMaps: string[] = [];
  for (const map of proj.maps) {
    const rec = reached.get(map.id);
    if (!rec) {
      notFoundMaps.push(map.id);
      maps.push({ map: map.id, status: "notFound", frontier: frontierFor(proj, map.id, observedPages, triggeredPages) });
      continue;
    }
    const witness = rec.kind === "node"
      ? materialize(rec.node)
      : { hz: CHECK_HZ as 60, masks: [...materialize(rec.parent).masks, ...rec.suffix] };
    const expectedHash = rec.kind === "node" ? rec.node.stateHash : rec.hash;
    const verdict = verifyWitness(verifySession, proj, witness, map.id, expectedHash, sw0);
    if (!verdict.ok) {
      // A witness that does not replay is a tool bug, never a verdict.
      findings.push(makeFinding(
        "reach/witness-replay-failed",
        "error",
        `the recorded witness for ${JSON.stringify(map.id)} failed replay: ${verdict.reason}`,
        "this is a check-tool bug; please report it with the project",
        { map: map.id },
      ));
      notFoundMaps.push(map.id);
      maps.push({ map: map.id, status: "notFound", frontier: frontierFor(proj, map.id, observedPages, triggeredPages) });
      continue;
    }
    reachableMaps.push(map.id);
    maps.push({ map: map.id, status: "reached", frames: witness.masks.length, witness, stateHash: expectedHash });
  }

  for (const mapId of notFoundMaps) {
    const f = maps.find((m) => m.map === mapId && m.status === "notFound");
    const inbound = f && f.status === "notFound" ? f.frontier.inbound.length : 0;
    findings.push(makeFinding(
      "reach/map-not-found",
      "warning",
      `no replayable witness to map ${JSON.stringify(mapId)} was found within budget (${statesExplored} states explored, ${framesRun} frames, ended: ${endedReason}) — a lead, not a proof`,
      inbound > 0
        ? `the map has ${inbound} static transfer route${inbound === 1 ? "" : "s"}; the report's frontier says whether its source pages ever ran`
        : "no literal transfer in the document names this map; check dynamic (variable-target) transfers, battle completions and extension logic",
      { map: mapId },
    ));
  }

  // --- goals report --------------------------------------------------------
  // Every met goal (and the combined witness) is replayed in a fresh session
  // and re-evaluated against the replayed final state: a witness that does
  // not replay is a tool bug (an error finding), never a "met". An unmet run
  // reports the closest state (the most goals satisfied at one state) with
  // its own replayable witness, and when a budget stopped the search, a
  // larger budget worth retrying with.
  /** A larger budget worth retrying with when a budget stopped the search
   *  (a heuristic, not a promise). Shared by the goals section and the
   *  no-goal "every map" hint. */
  const suggestedBudget = (): ReachGoalsReport["suggestedBudget"] => {
    if (endedReason === "frame-budget") return { maxFrames: Math.max(framesRun, 1) * 2 };
    if (endedReason === "state-budget") return { maxStates: Math.max(statesExplored, 1) * 2 };
    if (endedReason === "time-budget") return { maxSeconds: Math.max(maxSeconds, 0.001) * 2 };
    return undefined;
  };
  // The start the search ran from, when it was not the project start, so a
  // replay can reconstruct the same origin (map, position, bank). Shared by
  // the goals report and the no-goal closest.
  const startInfo = options.start
    ? {
        map: start.map,
        x: start.x,
        y: start.y,
        ...(start.dir ? { dir: start.dir } : {}),
        ...(start.switches ? { switches: start.switches } : {}),
        ...(start.variables ? { variables: start.variables } : {}),
        ...(start.items ? { items: start.items } : {}),
        ...(start.gold !== undefined ? { gold: start.gold } : {}),
      }
    : undefined;
  let goalsReport: ReachGoalsReport | undefined;
  if (goalExpr) {
    // The effective combinator is the expression's own: a single `any(...)`
    // goal string is an any-expression even when the --goal-mode option was
    // left at all. The canonical expr string is what a replay re-evaluates.
    const effectiveMode: "all" | "any" =
      "op" in goalExpr && (goalExpr.op === "all" || goalExpr.op === "any") ? goalExpr.op : goalMode;
    const exprText = formatGoalExpr(goalExpr);
    const materializeHit = (hit: GoalHit): ReachWitness => ({
      hz: CHECK_HZ as 60,
      masks: [...(hit.parent ? materialize(hit.parent).masks : []), ...hit.suffix],
    });
    const closestFromBest = (): ReachClosest => {
      const b = best!;
      const satisfiedNames = goalLeaves.filter((_, i) => b.satisfied[i]).map((g) => formatGoal(g));
      const unsatisfiedNames = goalLeaves.filter((_, i) => !b.satisfied[i]).map((g) => formatGoal(g));
      const base = {
        final: summarizeState(b.hit.state),
        satisfied: satisfiedNames,
        unsatisfied: unsatisfiedNames,
        frames: 0,
      };
      const witness = materializeHit(b.hit);
      base.frames = witness.masks.length;
      const verdict = verifyWitness(verifySession, proj, witness, b.hit.state.mapId, b.hit.hash, sw0);
      if (!verdict.ok) {
        findings.push(makeFinding(
          "reach/witness-replay-failed",
          "error",
          `the recorded witness for the closest goal state failed replay: ${verdict.reason}`,
          "this is a check-tool bug; please report it with the project",
          {},
        ));
        return base;
      }
      return { ...base, final: summarizeState(verdict.replay.state), witness };
    };
    const results: ReachGoalResult[] = goalLeaves.map((g, i) => {
      const hit = leafHits[i];
      if (!hit) return { goal: formatGoal(g), status: "unmet" };
      const witness = materializeHit(hit);
      const verdict = verifyWitness(verifySession, proj, witness, hit.state.mapId, hit.hash, sw0);
      if (!verdict.ok) {
        findings.push(makeFinding(
          "reach/witness-replay-failed",
          "error",
          `the recorded witness for goal ${formatGoal(g)} failed replay: ${verdict.reason}`,
          "this is a check-tool bug; please report it with the project",
          {},
        ));
        return { goal: formatGoal(g), status: "unmet" };
      }
      return { goal: formatGoal(g), status: "met", witness, final: summarizeState(verdict.replay.state) };
    });
    if (combinedHit) {
      const witness = materializeHit(combinedHit);
      const verdict = verifyWitness(verifySession, proj, witness, combinedHit.state.mapId, combinedHit.hash, sw0);
      if (verdict.ok && evalGoalExpr(goalExpr, { state: verdict.replay.state, session: verifySession })) {
        goalsReport = {
          mode: effectiveMode,
          status: "met",
          expr: exprText,
          results,
          witness,
          expectedHash: combinedHit.hash,
          final: summarizeState(verdict.replay.state),
          ...(startInfo ? { start: startInfo } : {}),
        };
      } else {
        if (!verdict.ok) {
          findings.push(makeFinding(
            "reach/witness-replay-failed",
            "error",
            `the recorded goal witness failed replay: ${verdict.reason}`,
            "this is a check-tool bug; please report it with the project",
            {},
          ));
        }
        goalsReport = {
          mode: effectiveMode,
          status: "unmet",
          expr: exprText,
          results,
          closest: closestFromBest(),
          ...(startInfo ? { start: startInfo } : {}),
          ...(suggestedBudget() ? { suggestedBudget: suggestedBudget() } : {}),
        };
      }
    } else {
      goalsReport = {
        mode: effectiveMode,
        status: "unmet",
        expr: exprText,
        results,
        closest: closestFromBest(),
        ...(startInfo ? { start: startInfo } : {}),
        ...(suggestedBudget() ? { suggestedBudget: suggestedBudget() } : {}),
      };
    }
  }

  // No goals, budget stop, maps still unfound: the implicit "every map" goal
  // was not met. Give the same lead a goals run gives — the deepest explored
  // state (the farthest story progress the search made) with its own
  // replayable witness, and a larger budget worth retrying with.
  let closestState: ReachReport["closest"];
  let noGoalBudgetHint: ReachReport["suggestedBudget"];
  if (
    !goalExpr &&
    notFoundMaps.length > 0 &&
    (endedReason === "frame-budget" || endedReason === "state-budget" || endedReason === "time-budget")
  ) {
    const witness = materialize(deepest);
    const verdict = verifyWitness(verifySession, proj, witness, deepest.state.mapId, deepest.stateHash, sw0);
    if (!verdict.ok) {
      findings.push(makeFinding(
        "reach/witness-replay-failed",
        "error",
        `the recorded witness for the closest explored state failed replay: ${verdict.reason}`,
        "this is a check-tool bug; please report it with the project",
        {},
      ));
    } else {
      closestState = {
        final: summarizeState(verdict.replay.state),
        depth: deepest.depth,
        frames: witness.masks.length,
        witness,
        expectedHash: deepest.stateHash,
        ...(startInfo ? { start: startInfo } : {}),
      };
      noGoalBudgetHint = suggestedBudget();
    }
  }

  return {
    check: "reach",
    findings,
    summary: {
      maps: proj.maps.length,
      reached: reachableMaps.length,
      notFound: notFoundMaps.length,
      statesExplored,
      statesQueued: queue.size,
      framesRun,
      endedReason,
      ...(goalExpr ? { goals: goalsMet ? "met" : "unmet" } : {}),
    },
    start: `${start.map}@${start.x},${start.y}`,
    battlePolicy,
    endedReason,
    budgets: { maxFrames, maxStates, maxSeconds },
    maps,
    reachableMaps,
    notFoundMaps,
    ...(goalsReport ? { goals: goalsReport } : {}),
    ...(closestState ? { closest: closestState } : {}),
    ...(noGoalBudgetHint ? { suggestedBudget: noGoalBudgetHint } : {}),
    assumptions: reachAssumptions(options.sessionOptions),
  };
}

// --- frontier -------------------------------------------------------------------

/** The static routes into a map and what the search observed about each
 *  source page: triggered (a fiber ran), observed-active (the condition held
 *  in some explored state but nobody confirmed it), never-active, or dynamic
 *  (a variable-target transfer). */
function frontierFor(
  project: Project,
  mapId: string,
  observedPages: ReadonlySet<string>,
  triggeredPages: ReadonlySet<string>,
): ReachFrontier {
  const inbound: ReachInboundRef[] = [];
  for (const map of project.maps) {
    for (const ev of map.events ?? []) {
      ev.pages.forEach((page, pageIndex) => {
        const pageKey = `${map.id}/${ev.id}#${pageIndex}`;
        for (const cmd of page.commands) {
          collectInbound(project, cmd, mapId, { map: map.id, event: ev.id, page: pageIndex }, pageKey, observedPages, triggeredPages, inbound, new Set());
        }
      });
    }
  }
  for (const common of project.commonEvents ?? []) {
    for (const cmd of common.commands) {
      collectInbound(project, cmd, mapId, { common: common.id }, common.id, observedPages, triggeredPages, inbound, new Set());
    }
  }
  return { inbound };
}

function collectInbound(
  project: Project,
  cmd: import("../../../../src/engine/types.ts").Command,
  mapId: string,
  loc: FindingLocation,
  pageKey: string,
  observedPages: ReadonlySet<string>,
  triggeredPages: ReadonlySet<string>,
  inbound: ReachInboundRef[],
  expanding: ReadonlySet<string>,
): void {
  if (cmd.op === "transfer") {
    if (cmd.map === mapId) {
      inbound.push({
        source: loc.map ?? loc.common ?? "?",
        loc,
        state: triggeredPages.has(pageKey) ? "triggered" : observedPages.has(pageKey) ? "observed-active" : "never-active",
      });
    } else if (typeof cmd.map !== "string") {
      inbound.push({ source: loc.map ?? loc.common ?? "?", loc, state: "dynamic" });
    }
    return;
  }
  // Descend into branches and common calls. A recursive common event is not
  // re-expanded (the real interpreter runaways on it).
  switch (cmd.op) {
    case "if":
      for (const c of cmd.then) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      if (cmd.else) for (const c of cmd.else) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      break;
    case "choices":
      for (const opt of cmd.options) for (const c of opt.commands) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      if (cmd.cancel) for (const c of cmd.cancel.commands) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      break;
    case "battle":
      if (cmd.onWin) for (const c of cmd.onWin) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      if (cmd.onLose) for (const c of cmd.onLose) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      if (cmd.onEscape) for (const c of cmd.onEscape) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      break;
    case "scene":
      if (cmd.onDone) for (const c of cmd.onDone) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      if (cmd.onCancel) for (const c of cmd.onCancel) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      break;
    case "loop":
      for (const c of cmd.commands) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      break;
    case "common": {
      if (expanding.has(cmd.id)) break;
      const common = project.commonEvents?.find((e) => e.id === cmd.id);
      if (common) {
        const next = new Set(expanding);
        next.add(cmd.id);
        for (const c of common.commands) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, next);
      }
      break;
    }
    default:
      break;
  }
}

// --- report helpers ---------------------------------------------------------------

function emptyReport(
  project: Project,
  findings: Finding[],
  start: { map: string; x: number; y: number },
  battlePolicy: ReachReport["battlePolicy"],
  maxFrames: number,
  maxStates: number,
  maxSeconds: number,
  sessionOptions?: SessionOptions,
  goalExpr?: ReachGoalExpr,
  goalMode: "all" | "any" = "all",
): ReachReport {
  return {
    check: "reach",
    findings,
    summary: {
      maps: project.maps.length,
      reached: 0,
      notFound: project.maps.length,
      statesExplored: 0,
      statesQueued: 0,
      framesRun: 0,
      endedReason: "exhausted",
      ...(goalExpr ? { goals: "unmet" } : {}),
    },
    start: `${start.map}@${start.x},${start.y}`,
    battlePolicy,
    endedReason: "exhausted",
    budgets: { maxFrames, maxStates, maxSeconds },
    maps: project.maps.map((m) => ({ map: m.id, status: "notFound" as const, frontier: { inbound: [] } })),
    reachableMaps: [],
    notFoundMaps: project.maps.map((m) => m.id),
    ...(goalExpr
      ? {
          goals: {
            mode: goalMode,
            status: "unmet" as const,
            expr: formatGoalExpr(goalExpr),
            results: leafGoals(goalExpr).map((g) => ({ goal: formatGoal(g), status: "unmet" as const })),
          },
        }
      : {}),
    assumptions: reachAssumptions(sessionOptions),
  };
}
