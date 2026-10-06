// editor/proposals/qa.ts — proposal-time QA gate.
//
// Runs the same static health checks as `rpgkit-check lint` against the
// document a proposal would produce, so reference and reachability problems
// are attached to the proposal before a human accepts it, and accept can
// re-run the gate against the live document. Every check is a pure function
// of the in-memory document: no session, no file system, no engine host.

import type { Project } from "../../src/engine/types.ts";
import { validateProject } from "../engine/document.ts";
import { semanticHash } from "../api/operations.ts";
import { lintProject } from "../../tools/rpgkit-check/src/lint.ts";
import type { Finding, FindingLocation, Severity } from "../../tools/rpgkit-check/src/finding.ts";

export type QaSeverity = Severity;

export interface QaFinding {
  severity: QaSeverity;
  /** Stable check id, e.g. "lint/sprite-missing" or "qa/schema". */
  code: string;
  message: string;
  suggestion?: string;
  /** JSON pointer, when the problem has a single document location. */
  path?: string;
  /** Stable lint location. Map/event/common ids survive map reordering; page
   * and command paths deliberately remain conservative positional keys. */
  loc?: FindingLocation;
}

export interface QaBaseline {
  format: "rpgkit-proposal-qa-baseline/v1";
  proposalId: string;
  baseHash: string;
  errors: QaFinding[];
}

export interface QaReport {
  checkedAt: string;
  /** Semantic hash of the document that was checked. */
  documentHash: string;
  findings: QaFinding[];
  errors: number;
  warnings: number;
  infos: number;
  /** Versioned, proposal-bound errors present at creation time. Omitted on
   * sidecars written by older builds, which therefore retain strict gating. */
  baseline?: QaBaseline;
}

function fromLintFinding(finding: Finding): QaFinding {
  return {
    severity: finding.severity,
    code: finding.check,
    message: finding.message,
    suggestion: finding.suggestion,
    loc: {
      ...finding.loc,
      ...(finding.loc.commandPath === undefined ? {} : { commandPath: [...finding.loc.commandPath] }),
    },
    ...(finding.loc.pointer === undefined ? {} : { path: finding.loc.pointer }),
  };
}

/** Schema validity plus the full static lint (references, page health,
 * transfer-graph reachability) over one proposed document. */
export function proposalQa(
  project: Project,
  now: () => string = () => new Date().toISOString(),
): QaReport {
  const findings: QaFinding[] = [];
  for (const error of validateProject(project)) {
    findings.push({ severity: "error", code: "qa/schema", message: error.msg, path: error.path, loc: { pointer: error.path } });
  }
  const report = lintProject(project);
  for (const finding of report.findings) findings.push(fromLintFinding(finding));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return {
    checkedAt: now(),
    documentHash: "",
    findings,
    errors: counts.error,
    warnings: counts.warning,
    infos: counts.info,
  };
}

/** A QA report with the hash of the checked document filled in. The hash is
 * what later `show`/`list` views compare against the live document. */
export function qaReportFor(project: Project, now: () => string = () => new Date().toISOString()): QaReport {
  const report = proposalQa(project, now);
  return { ...report, documentHash: semanticHash(project) };
}

/** QA for a document assembled solely from already validated shell globals
 * and map shards. References and reachability still inspect every map. */
export function qaReportForValidatedProject(
  project: Project,
  documentHash: string,
  now: () => string = () => new Date().toISOString(),
): QaReport {
  const findings = lintProject(project).findings.map(fromLintFinding);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return {
    checkedAt: now(),
    documentHash,
    findings,
    errors: counts.error,
    warnings: counts.warning,
    infos: counts.info,
  };
}

export function qaWithBaseline(
  report: QaReport,
  baseline: QaReport,
  proposalId: string,
  baseHash: string,
): QaReport {
  return {
    ...report,
    baseline: {
      format: "rpgkit-proposal-qa-baseline/v1",
      proposalId,
      baseHash,
      errors: baseline.findings.filter((finding) => finding.severity === "error"),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validLocation(value: unknown): value is FindingLocation {
  if (!isRecord(value)) return false;
  const allowed = new Set(["map", "event", "common", "page", "commandPath", "pointer"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (["map", "event", "common", "pointer"].some((key) => value[key] !== undefined && typeof value[key] !== "string")) return false;
  if (value.page !== undefined && (!Number.isInteger(value.page) || (value.page as number) < 0)) return false;
  return value.commandPath === undefined || Array.isArray(value.commandPath) &&
    value.commandPath.every((part) => typeof part === "string" || Number.isInteger(part));
}

function validBaselineFinding(value: unknown): value is QaFinding {
  if (!isRecord(value) || value.severity !== "error" || typeof value.code !== "string" || typeof value.message !== "string") return false;
  if (value.suggestion !== undefined && typeof value.suggestion !== "string") return false;
  if (value.path !== undefined && typeof value.path !== "string") return false;
  return value.loc === undefined || validLocation(value.loc);
}

function storedBaseline(
  stored: QaReport | null,
  proposalId: string,
  baseHash: string,
): QaBaseline | null {
  const baseline = stored?.baseline as unknown;
  if (!isRecord(baseline) || baseline.format !== "rpgkit-proposal-qa-baseline/v1" ||
    baseline.proposalId !== proposalId || baseline.baseHash !== baseHash || !Array.isArray(baseline.errors) ||
    !baseline.errors.every(validBaselineFinding)) return null;
  return baseline as unknown as QaBaseline;
}

export function qaWithStoredBaseline(
  report: QaReport,
  stored: QaReport | null,
  proposalId: string,
  baseHash: string,
): QaReport {
  const baseline = storedBaseline(stored, proposalId, baseHash);
  return baseline === null ? report : { ...report, baseline };
}

function findingIdentity(finding: QaFinding): string {
  const loc = finding.loc;
  return JSON.stringify([
    finding.code,
    finding.message,
    loc?.map ?? null,
    loc?.event ?? null,
    loc?.common ?? null,
    loc?.page ?? null,
    loc?.commandPath ?? null,
    loc?.pointer ?? finding.path ?? null,
  ]);
}

/** Return accept-time error regressions. Counts matter, so another identical
 * pathless lint is new. Legacy sidecars without a baseline fail closed. */
export function qaNewErrors(
  report: QaReport,
  stored: QaReport | null,
  proposalId: string,
  baseHash: string,
): QaFinding[] {
  const current = report.findings.filter((finding) => finding.severity === "error");
  const baseline = storedBaseline(stored, proposalId, baseHash);
  if (baseline === null) return current;
  const allowed = new Map<string, number>();
  for (const finding of baseline.errors) {
    const key = findingIdentity(finding);
    allowed.set(key, (allowed.get(key) ?? 0) + 1);
  }
  return current.filter((finding) => {
    const key = findingIdentity(finding);
    const count = allowed.get(key) ?? 0;
    if (count === 0) return true;
    allowed.set(key, count - 1);
    return false;
  });
}

export function qaHasErrors(report: QaReport): boolean {
  return report.errors > 0;
}

export function qaSummary(report: QaReport): { checkedAt: string; errors: number; warnings: number; infos: number } {
  return { checkedAt: report.checkedAt, errors: report.errors, warnings: report.warnings, infos: report.infos };
}
