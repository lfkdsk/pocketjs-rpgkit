// editor/studio/problems.ts — one list for schema validation problems (the
// protocol's `validate`), rpgkit-check lint findings and the doctor's
// fixable findings, each with a location Studio can jump to. Pure (no DOM)
// so it is unit-tested.

import type { Project } from "../../src/engine/types.ts";
import type { SessionProblem } from "../api/session.ts";
import type { CommandAddress, CommandListPathSegment } from "../engine/commands.ts";
import { lintProject } from "../../tools/rpgkit-check/src/lint.ts";
import { doctorFindings, type DoctorFix } from "./doctor.ts";

/** A one-click repair: the operations to run in one transaction. */
export type StudioProblemFix = DoctorFix;

export interface StudioProblem {
  severity: "error" | "warning" | "info";
  source: "schema" | "check" | "doctor";
  message: string;
  /** Check id (rpgkit-check/doctor) or the JSON path (schema). */
  code: string;
  map?: string;
  event?: string;
  common?: string;
  page?: number;
  /** Command selected when the finding identifies an editable command. */
  command?: CommandAddress;
  /** Present when the problem can be repaired with one undoable transaction. */
  fix?: StudioProblemFix;
}

/** Resolve map-event and common-event schema paths against the document. */
export function locateSchemaPath(project: Pick<Project, "maps" | "commonEvents"> | null, path: string): Pick<StudioProblem, "map" | "event" | "common" | "page"> {
  const out: Pick<StudioProblem, "map" | "event" | "common" | "page"> = {};
  const commonMatch = /^\$\.commonEvents\[(\d+)\]/.exec(path);
  if (commonMatch && project) {
    const common = project.commonEvents?.[Number(commonMatch[1])];
    if (common) out.common = common.id;
    return out;
  }
  const mapMatch = /^\$\.maps\[(\d+)\]/.exec(path);
  if (!mapMatch || !project) return out;
  const map = project.maps[Number(mapMatch[1])];
  if (!map) return out;
  out.map = map.id;
  const eventMatch = /^\$\.maps\[\d+\]\.events\[(\d+)\]/.exec(path);
  const event = eventMatch ? map.events?.[Number(eventMatch[1])] : undefined;
  if (!event) return out;
  out.event = event.id;
  const pageMatch = /^\$\.maps\[\d+\]\.events\[\d+\]\.pages\[(\d+)\]/.exec(path);
  if (pageMatch && event.pages[Number(pageMatch[1])]) out.page = Number(pageMatch[1]);
  return out;
}

/** Convert rpgkit-check's compact command path into Studio's typed command
 * address. Paths that continue through a called common event or into a
 * non-command resource (for example an option icon) stop at the owning
 * command, which is still the most useful place Studio can reveal. */
export function findingCommandAddress(path: readonly (number | string)[] | undefined): CommandAddress | undefined {
  if (!path || typeof path[0] !== "number") return undefined;
  const listPath: CommandListPathSegment[] = [];
  let index = path[0];
  for (let at = 1; at < path.length;) {
    const branch = path[at];
    if (typeof branch !== "string") break;
    const child = path[at + 1];
    if (branch === "then" || branch === "else") {
      if (typeof child !== "number") break;
      listPath.push({ kind: "if", index, branch });
      index = child;
      at += 2;
    } else if (branch === "options") {
      const option = child;
      const command = path[at + 2];
      if (typeof option !== "number" || typeof command !== "number") break;
      listPath.push({ kind: "choices", index, branch: "option", option });
      index = command;
      at += 3;
    } else if (branch === "cancel") {
      if (typeof child !== "number") break;
      listPath.push({ kind: "choices", index, branch: "cancel" });
      index = child;
      at += 2;
    } else if (branch === "onWin" || branch === "onLose" || branch === "onEscape") {
      if (typeof child !== "number") break;
      listPath.push({ kind: "battle", index, branch: branch === "onWin" ? "win" : branch === "onLose" ? "lose" : "escape" });
      index = child;
      at += 2;
    } else if (branch === "onDone" || branch === "onCancel") {
      if (typeof child !== "number") break;
      listPath.push({ kind: "scene", index, branch: branch === "onDone" ? "done" : "cancel" });
      index = child;
      at += 2;
    } else if (branch === "commands") {
      if (typeof child !== "number") break;
      listPath.push({ kind: "loop", index, branch: "body" });
      index = child;
      at += 2;
    } else {
      break;
    }
  }
  return { path: listPath, index };
}

export function schemaProblems(project: Pick<Project, "maps" | "commonEvents"> | null, problems: readonly SessionProblem[]): StudioProblem[] {
  return problems.map((problem) => ({
    severity: "error",
    source: "schema",
    message: problem.msg,
    code: problem.path,
    ...locateSchemaPath(project, problem.path),
  }));
}

/** rpgkit-check's static lint over an inline project. */
export function checkProblems(project: Project): StudioProblem[] {
  return lintProject(project).findings.map((finding) => ({
    severity: finding.severity,
    source: "check",
    message: `${finding.message}. ${finding.suggestion}`,
    code: finding.check,
    ...(finding.loc.map === undefined ? {} : { map: finding.loc.map }),
    ...(finding.loc.event === undefined ? {} : { event: finding.loc.event }),
    ...(finding.loc.common === undefined ? {} : { common: finding.loc.common }),
    ...(finding.loc.page === undefined ? {} : { page: finding.loc.page }),
    ...(findingCommandAddress(finding.loc.commandPath) === undefined ? {} : { command: findingCommandAddress(finding.loc.commandPath) }),
  }));
}

/** The doctor's fixable findings over an inline project. */
export function doctorProblems(project: Project): StudioProblem[] {
  return doctorFindings(project).map((finding) => ({
    severity: finding.severity,
    source: "doctor" as const,
    message: finding.message,
    code: finding.check,
    ...(finding.loc.map === undefined ? {} : { map: finding.loc.map }),
    ...(finding.loc.event === undefined ? {} : { event: finding.loc.event }),
    ...(finding.loc.page === undefined ? {} : { page: finding.loc.page }),
    ...(finding.fix ? { fix: finding.fix } : {}),
  }));
}

/** Doctor checks that restate a lint check on the same issue. When the doctor
 *  finds the same issue at the same location, its fix is attached to the lint
 *  line and the doctor line is dropped: the Problems panel shows one row with
 *  a Fix button instead of a lint row and a doctor row for the same defect.
 *  Doctor findings without a lint equivalent (autorun-restarts-every-frame) and
 *  ones whose lint line is absent stay as their own rows. */
const LINT_EQUIVALENT: Record<string, string> = {
  "doctor/label-missing": "lint/jump-label-missing",
  "doctor/transfer-target-missing": "lint/transfer-target-missing",
  "doctor/common-event-missing": "lint/common-event-missing",
};

function sameLoc(a: Pick<StudioProblem, "map" | "event" | "common" | "page">, b: Pick<StudioProblem, "map" | "event" | "common" | "page">): boolean {
  return a.map === b.map && a.event === b.event && a.common === b.common && a.page === b.page;
}

export function mergeCheckAndDoctor(checks: StudioProblem[], doctor: StudioProblem[]): StudioProblem[] {
  const merged = checks.map((problem) => ({ ...problem }));
  const mergedLintLines = new Set<number>();
  const kept: StudioProblem[] = [];
  for (const finding of doctor) {
    const lintCode = finding.fix ? LINT_EQUIVALENT[finding.code] : undefined;
    const lintIndex = lintCode
      ? merged.findIndex((problem, index) =>
        !mergedLintLines.has(index) &&
        problem.source === "check" &&
        problem.code === lintCode &&
        sameLoc(problem, finding))
      : -1;
    if (lintIndex >= 0) {
      merged[lintIndex] = { ...merged[lintIndex]!, fix: finding.fix };
      mergedLintLines.add(lintIndex);
    } else {
      kept.push(finding);
    }
  }
  return [...merged, ...kept];
}
