// tests/studio-problems-merge.test.ts — the Problems panel shows one row per
// defect: when the doctor restates a lint finding at the same location, its
// fix is attached to the lint row instead of adding a duplicate line.

import { describe, expect, test } from "bun:test";
import {
  findingCommandAddress,
  locateSchemaPath,
  mergeCheckAndDoctor,
  type StudioProblem,
} from "../editor/studio/problems.ts";

type ProblemLocation = Pick<StudioProblem, "map" | "event" | "common" | "page">;

function lint(code: string, loc: ProblemLocation): StudioProblem {
  return { severity: "warning", source: "check", message: `lint ${code}`, code, ...loc };
}

function doctor(code: string, loc: ProblemLocation, fix = true): StudioProblem {
  return {
    severity: "warning",
    source: "doctor",
    message: `doctor ${code}`,
    code,
    ...loc,
    ...(fix ? { fix: { label: "Fix it", description: "fixes it", ops: [] } } : {}),
  };
}

describe("mergeCheckAndDoctor", () => {
  test("attaches the doctor fix to the matching lint line and drops the duplicate", () => {
    const checks = [lint("lint/jump-label-missing", { map: "town", event: "npc", page: 0 })];
    const doctorProblems = [doctor("doctor/label-missing", { map: "town", event: "npc", page: 0 })];
    const merged = mergeCheckAndDoctor(checks, doctorProblems);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe("check");
    expect(merged[0]!.fix).toBeDefined();
    expect(merged[0]!.fix!.label).toBe("Fix it");
  });

  test("keeps a doctor finding without a lint equivalent as its own row", () => {
    const checks = [lint("lint/some-other-check", { map: "town", event: "npc", page: 0 })];
    const doctorProblems = [doctor("doctor/autorun-restarts-every-frame", { map: "town", event: "npc", page: 0 })];
    const merged = mergeCheckAndDoctor(checks, doctorProblems);
    expect(merged).toHaveLength(2);
    expect(merged.some((p) => p.source === "doctor" && p.fix)).toBe(true);
  });

  test("does not merge a doctor finding whose lint line is at a different location", () => {
    const checks = [lint("lint/jump-label-missing", { map: "town", event: "npc", page: 0 })];
    const doctorProblems = [doctor("doctor/label-missing", { map: "town", event: "other", page: 0 })];
    const merged = mergeCheckAndDoctor(checks, doctorProblems);
    expect(merged).toHaveLength(2);
    expect(merged.find((p) => p.source === "check")!.fix).toBeUndefined();
  });

  test("a report-only doctor finding (no fix) stays its own row", () => {
    const checks = [lint("lint/selfswitch-read-never-set", { map: "town", event: "npc" })];
    const doctorProblems = [doctor("doctor/selfswitch-never-set", { map: "town", event: "npc", page: 0 }, false)];
    const merged = mergeCheckAndDoctor(checks, doctorProblems);
    expect(merged).toHaveLength(2);
  });

  test("the same lint line receives only one fix when several doctor findings match", () => {
    // Two doctor findings on the same page+check (e.g. two jumps to missing
    // labels on one page) both match the one lint line: the first fix wins,
    // the second doctor finding stays as its own row rather than overwriting.
    const checks = [lint("lint/jump-label-missing", { map: "town", event: "npc", page: 0 })];
    const doctorProblems = [
      doctor("doctor/label-missing", { map: "town", event: "npc", page: 0 }),
      doctor("doctor/label-missing", { map: "town", event: "npc", page: 0 }),
    ];
    const merged = mergeCheckAndDoctor(checks, doctorProblems);
    expect(merged).toHaveLength(2);
    expect(merged.filter((p) => p.source === "check")).toHaveLength(1);
    expect(merged.filter((p) => p.source === "doctor")).toHaveLength(1);
  });

  test("does not merge findings from different common events", () => {
    const checks = [lint("lint/jump-label-missing", { common: "healing" })];
    const doctorProblems = [doctor("doctor/label-missing", { common: "cutscene" })];
    expect(mergeCheckAndDoctor(checks, doctorProblems)).toHaveLength(2);
  });
});

describe("common-event problem locations", () => {
  test("resolves schema paths to the stable common-event id", () => {
    const project = {
      maps: [],
      commonEvents: [
        { id: "healing", trigger: "none" as const, commands: [] },
        { id: "weather", trigger: "parallel" as const, commands: [] },
      ],
    };
    expect(locateSchemaPath(project, "$.commonEvents[1].commands[0]")).toEqual({ common: "weather" });
  });

  test("converts nested lint paths into command addresses", () => {
    expect(findingCommandAddress([2, "then", 1, "options", 3, 0])).toEqual({
      path: [
        { kind: "if", index: 2, branch: "then" },
        { kind: "choices", index: 1, branch: "option", option: 3 },
      ],
      index: 0,
    });
    expect(findingCommandAddress([4, "onEscape", 2])).toEqual({
      path: [{ kind: "battle", index: 4, branch: "escape" }],
      index: 2,
    });
  });

  test("stops at the caller when a finding path enters an inlined common event", () => {
    expect(findingCommandAddress([3, "common", "healing", 0])).toEqual({ path: [], index: 3 });
  });
});
