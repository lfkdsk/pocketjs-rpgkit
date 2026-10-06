// tools/rpgkit-check/src/dynamic/reach-replay.ts — independent witness
// re-verification for the reach check.
//
// `reach --replay <file>` (and the rpgkit-reach-replay MCP tool) replays a
// recorded witness tape in a FRESH session, tick by tick at 60 Hz, and
// checks the result three ways:
//
//   1. the replay ends on the recorded state hash (the tape really reaches
//      the recorded state — no trust in the search that recorded it);
//   2. the replay ends on the target map when the witness names one;
//   3. every goal the witness file carries re-evaluates on the replayed
//      final state.
//
// The file is either a bare witness ({hz, masks, ...}) or a full reach
// report whose goals section carries one. A bare witness may also carry
// expectedHash, targetMap, goals, goalMode, expr and start.

import { createSession } from "../../../../src/engine/session.ts";
import type { SessionOptions } from "../../../../src/engine/session.ts";
import type { Project } from "../../../../src/engine/types.ts";
import { checkSessionOptions, projectWithStart, reachStartSwitchState } from "./sim.ts";
import {
  replayWitness,
  stateHash,
  type ReachWitness,
} from "./reach-witness.ts";
import {
  evalGoal,
  evalGoalExpr,
  formatGoal,
  leafGoals,
  parseGoalExpr,
  parseGoals,
  summarizeState,
  GoalParseError,
  type ReachGoalExpr,
  type ReachStateSummary,
} from "./reach-goal.ts";

export interface ReachStartBank {
  map?: string;
  x?: number;
  y?: number;
  dir?: "down" | "left" | "up" | "right";
  switches?: Record<string, boolean>;
  variables?: Record<string, number>;
  items?: Record<string, number>;
  gold?: number;
}

/** What a replay file carries: a tape and the claims to re-verify. */
export interface ReachReplayFile {
  witness: ReachWitness;
  expectedHash?: string;
  targetMap?: string;
  /** Goal strings to re-evaluate on the replayed final state. */
  goals?: string[];
  goalMode?: "all" | "any";
  /** Canonical goal expression (formatGoalExpr). When present it is the
   *  faithful source — goals/goalMode are only a display fallback — so a
   *  replay evaluates the SAME any/all/nested expression the search did. */
  goalExprText?: string;
  startBank?: ReachStartBank;
}

export interface ReachReplayVerdict {
  ok: boolean;
  /** Why the verification failed, when it did. */
  reason?: string;
  final: ReachStateSummary;
  finalHash: string;
  frames: number;
  /** Per-goal re-evaluation on the replayed final state. */
  goals?: { goal: string; ok: boolean }[];
}

function readJson(path: string): unknown {
  // Bun/Node fs; the check tools already run under Bun.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
}

/** Load a replay file: a bare witness or a reach report with a goals
 *  section. Throws an Error with a usage message on anything else. */
export function loadReplayFile(path: string): ReachReplayFile {
  const doc = readJson(path) as Record<string, unknown>;
  // A reach report: pull the goals section's witness.
  if (doc["check"] === "reach") {
    const goals = doc["goals"] as Record<string, unknown> | undefined;
    if (goals && typeof goals === "object") {
      const witness = goals["witness"] as ReachWitness | undefined;
      const closest = goals["closest"] as Record<string, unknown> | undefined;
      const source = witness ?? closest?.["witness"];
      if (!source || typeof source !== "object") {
        throw new Error(`${path}: reach report goals section has no witness (the goals were not met and no closest state was recorded)`);
      }
      const results = Array.isArray(goals["results"]) ? (goals["results"] as { goal?: unknown }[]) : [];
      return {
        witness: source as ReachWitness,
        expectedHash: typeof goals["expectedHash"] === "string" ? (goals["expectedHash"] as string) : undefined,
        goals: results.map((r) => String(r.goal)),
        goalMode: goals["mode"] === "any" ? "any" : "all",
        goalExprText: typeof goals["expr"] === "string" ? (goals["expr"] as string) : undefined,
        startBank: goals["start"] as ReachStartBank | undefined,
      };
    }
    // A no-goal run: the top-level closest state is the lead (the farthest
    // story progress the search made), with its own replayable witness.
    const closest = doc["closest"] as Record<string, unknown> | undefined;
    const closestWitness = closest?.["witness"];
    if (closest && typeof closest === "object" && closestWitness && typeof closestWitness === "object") {
      const final = closest["final"] as Record<string, unknown> | undefined;
      return {
        witness: closestWitness as ReachWitness,
        expectedHash: typeof closest["expectedHash"] === "string" ? (closest["expectedHash"] as string) : undefined,
        targetMap: typeof final?.["map"] === "string" ? (final["map"] as string) : undefined,
        startBank: closest["start"] as ReachStartBank | undefined,
      };
    }
    throw new Error(`${path}: reach report has no goals section or closest state; run reach with --goal first, or on a budget that stops with maps unfound`);
  }
  // A bare witness object.
  if (doc["hz"] !== 60 || !Array.isArray(doc["masks"])) {
    throw new Error(`${path}: not a reach witness (need {hz: 60, masks: [...]} or a reach report)`);
  }
  return {
    witness: { hz: 60, masks: doc["masks"] as number[] },
    expectedHash: typeof doc["expectedHash"] === "string" ? (doc["expectedHash"] as string) : undefined,
    targetMap: typeof doc["targetMap"] === "string" ? (doc["targetMap"] as string) : undefined,
    goals: Array.isArray(doc["goals"]) ? (doc["goals"] as unknown[]).map(String) : undefined,
    goalMode: doc["goalMode"] === "any" ? "any" : undefined,
    goalExprText: typeof doc["expr"] === "string" ? (doc["expr"] as string) : undefined,
    startBank: doc["start"] as ReachStartBank | undefined,
  };
}

/** Replay a witness in a fresh session and re-verify its claims. `ok` means
 *  the tape replays to the recorded hash (and target map, when named) and
 *  every goal re-evaluates on the replayed final state. */
export function replayReachWitness(
  project: Project,
  file: ReachReplayFile,
  sessionOptions?: SessionOptions,
): ReachReplayVerdict {
  // A witness recorded from a custom start replays from that same start:
  // override the project's start map/position and seed the bank.
  const start = file.startBank;
  const proj = start && start.map && start.x !== undefined && start.y !== undefined
    ? projectWithStart(project, start.map, start.x, start.y, start.dir ?? project.start.dir)
    : project;
  const session = createSession(proj, 60, {
    ...checkSessionOptions(proj, sessionOptions),
  });
  // The search and the replay build the custom start's bank from the same
  // helper (sim.ts reachStartSwitchState) — including a start with no bank
  // fields, which still must seed the project's playerName/mapNameDisplay or
  // the replay hash mismatches.
  const sw0 = reachStartSwitchState(project, start);
  const replay = replayWitness(session, proj, file.witness, sw0);
  const finalHash = stateHash(replay.state);
  const base = {
    final: summarizeState(replay.state),
    finalHash,
    frames: file.witness.masks.length,
  };
  const fail = (reason: string): ReachReplayVerdict => ({ ok: false, reason, ...base });
  if (file.expectedHash !== undefined && replay.finalHash !== file.expectedHash) {
    return fail(`replay state hash ${replay.finalHash} does not match the recorded ${file.expectedHash}`);
  }
  if (file.targetMap !== undefined && replay.state.mapId !== file.targetMap) {
    return fail(`replay ends on ${JSON.stringify(replay.state.mapId)}, expected ${JSON.stringify(file.targetMap)}`);
  }
  if (file.goalExprText || (file.goals && file.goals.length > 0)) {
    // The same evaluator the search used: any/all and nested combinators
    // included. A bare goals+mode pair (older files, or a goals override)
    // wraps under the mode; a canonical expr string is the faithful source.
    let expr: ReachGoalExpr;
    try {
      expr = file.goalExprText
        ? parseGoalExpr(file.goalExprText)
        : parseGoals(file.goals!, file.goalMode ?? "all");
    } catch (err) {
      if (err instanceof GoalParseError) {
        throw new Error(`witness carries an unparsable goal expression: ${err.message}`);
      }
      throw err;
    }
    const ctx = { state: replay.state, session };
    const results = leafGoals(expr).map((g) => ({ goal: formatGoal(g), ok: evalGoal(g, ctx) }));
    if (!evalGoalExpr(expr, ctx)) {
      return {
        ok: false,
        reason: `goals not met on replay: ${results.filter((r) => !r.ok).map((r) => r.goal).join(", ")}`,
        ...base,
        goals: results,
      };
    }
    return { ok: true, ...base, goals: results };
  }
  return { ok: true, ...base };
}
