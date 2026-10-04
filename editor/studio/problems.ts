// editor/studio/problems.ts — one list for schema validation problems (the
// protocol's `validate`), rpgkit-check lint findings and the doctor's
// fixable findings, each with a location Studio can jump to. Pure (no DOM)
// so it is unit-tested.

import type { Project } from "../../src/engine/types.ts";
import type { SessionProblem } from "../api/session.ts";
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
  page?: number;
  /** Present when the problem can be repaired with one undoable transaction. */
  fix?: StudioProblemFix;
}

/** Resolve "$.maps[2].events[0].pages[1]…" against the document. */
export function locateSchemaPath(project: Pick<Project, "maps"> | null, path: string): Pick<StudioProblem, "map" | "event" | "page"> {
  const out: Pick<StudioProblem, "map" | "event" | "page"> = {};
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

export function schemaProblems(project: Pick<Project, "maps"> | null, problems: readonly SessionProblem[]): StudioProblem[] {
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
    ...(finding.loc.page === undefined ? {} : { page: finding.loc.page }),
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

function sameLoc(a: Pick<StudioProblem, "map" | "event" | "page">, b: Pick<StudioProblem, "map" | "event" | "page">): boolean {
  return a.map === b.map && a.event === b.event && a.page === b.page;
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
