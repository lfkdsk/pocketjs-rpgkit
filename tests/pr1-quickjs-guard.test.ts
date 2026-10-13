import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ANALYZER = resolve(ROOT, "tools/pr1-quickjs-analyze.awk");
const BASELINE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CANDIDATE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface AnalyzeOptions {
  rounds?: number;
  cases?: string[];
  limit?: string;
}

function runAnalyzer(rows: string[], options: AnalyzeOptions = {}) {
  const rounds = options.rounds ?? 1;
  const cases = options.cases ?? ["streamedRoam"];
  const limit = options.limit ?? "3.0";
  const proc = Bun.spawnSync({
    cmd: [
      "awk",
      "-v", `expected_rounds=${rounds}`,
      "-v", `expected_cases=${cases.join(" ")}`,
      "-v", "comparison=synthetic",
      "-v", `baseline_sha=${BASELINE_SHA}`,
      "-v", `candidate_sha=${CANDIDATE_SHA}`,
      "-v", `limit_pct=${limit}`,
      "-v", "bootstrap_samples=2000",
      "-f", ANALYZER,
    ],
    cwd: ROOT,
    stdin: new Blob([`${rows.join("\n")}\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function completeRows(
  rounds = 1,
  cases = ["streamedRoam"],
  candidateByCase: Record<string, number> = { streamedRoam: 101 },
): string[] {
  const rows: string[] = [];
  for (let round = 1; round <= rounds; round++) {
    for (let slot = 1; slot <= 4; slot++) {
      const outside = slot === 1 || slot === 4;
      const label = round % 2 === 1
        ? (outside ? "main" : "candidate")
        : (outside ? "candidate" : "main");
      for (const benchCase of cases) {
        const value = label === "main" ? 100 : candidateByCase[benchCase] ?? 101;
        rows.push(
          `PR1_QJS round=${round} slot=${slot} label=${label} case=${benchCase} ` +
            `mean_us=${value * 2} median_us=${value}`,
        );
      }
    }
  }
  return rows;
}

describe("PR1 QuickJS benchmark analyzer", () => {
  test("accepts a complete focused three-window counterbalanced transcript", () => {
    const result = runAnalyzer(completeRows(3), { rounds: 3 });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "case=streamedRoam pairs=6 statistic=median_us median_pct=+1.000000 " +
        "ci95_low_pct=+1.000000 ci95_high_pct=+1.000000 limit_pct=3.000000 verdict=pass",
    );
    expect(result.stdout).toContain(
      "PR1_QJS_COMPARISON_RESULT comparison=synthetic verdict=pass " +
        "failed_cases=0 inconclusive_cases=0 errors=0",
    );
  });

  test("treats a result exactly at the configured limit as passing", () => {
    const result = runAnalyzer(completeRows(1, ["streamedRoam"], { streamedRoam: 103 }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "median_pct=+3.000000 ci95_low_pct=+3.000000 ci95_high_pct=+3.000000 " +
        "limit_pct=3.000000 verdict=pass",
    );
  });

  test("returns one when a case exceeds the configured limit", () => {
    const result = runAnalyzer(completeRows(1, ["streamedRoam"], { streamedRoam: 104 }));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "case=streamedRoam pairs=2 statistic=median_us median_pct=+4.000000 " +
        "ci95_low_pct=+4.000000 ci95_high_pct=+4.000000 limit_pct=3.000000 verdict=fail",
    );
    expect(result.stdout).toContain("verdict=fail failed_cases=1 inconclusive_cases=0 errors=0");
  });

  test("reports each requested case independently", () => {
    const cases = ["streamedRoam", "sunstoneIdle"];
    const rows = completeRows(1, cases, { streamedRoam: 101, sunstoneIdle: 102 });
    const result = runAnalyzer(rows, { cases, limit: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("case=streamedRoam pairs=2 statistic=median_us median_pct=+1.000000");
    expect(result.stdout).toContain("case=sunstoneIdle pairs=2 statistic=median_us median_pct=+2.000000");
    expect(result.stdout).toContain("limit_pct=none verdict=info");
    expect(result.stdout).toContain("verdict=info failed_cases=0 inconclusive_cases=0 errors=0");
  });

  test("returns three when a requested slot is missing", () => {
    const rows = completeRows();
    rows.pop();
    const result = runAnalyzer(rows);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("missing row case=streamedRoam round=1 slot=4");
    expect(result.stdout).toContain("verdict=error failed_cases=0 inconclusive_cases=0 errors=1");
  });

  test("returns three when a slot is duplicated", () => {
    const rows = completeRows();
    rows.push(rows[0]!);
    const result = runAnalyzer(rows);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("duplicate row case=streamedRoam round=1 slot=1");
    expect(result.stdout).toContain("verdict=error failed_cases=0 inconclusive_cases=0 errors=1");
  });

  test("rejects a second window that does not reverse ABBA slot ownership", () => {
    const rows = completeRows(2);
    rows[4] = rows[4]!.replace("label=candidate", "label=main");
    const result = runAnalyzer(rows, { rounds: 2 });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("round=2 slot=1 label=main expected=candidate");
  });

  test("returns three for a non-positive measurement", () => {
    const rows = completeRows();
    rows[1] = rows[1]!.replace("median_us=101", "median_us=0");
    const result = runAnalyzer(rows);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("invalid median_us=0 case=streamedRoam round=1 slot=2");
    expect(result.stdout).toContain("verdict=error failed_cases=0 inconclusive_cases=0 errors=1");
  });

  test("uses per-slot medians rather than noisy means", () => {
    const rows = completeRows(3).map((row) =>
      row.replace(/mean_us=\d+/, row.includes("label=candidate") ? "mean_us=1000" : "mean_us=50")
    );
    const result = runAnalyzer(rows, { rounds: 3 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("statistic=median_us median_pct=+1.000000");
  });

  test("passes a within-limit point estimate when only the upper confidence tail crosses", () => {
    const rows = completeRows(3);
    for (let index = 0; index < rows.length; index++) {
      const round = Math.floor(index / 4);
      if (rows[index]!.includes("label=candidate")) {
        rows[index] = rows[index]!.replace("median_us=101", `median_us=${101 + round * 2}`);
      }
    }
    const result = runAnalyzer(rows, { rounds: 3 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "median_pct=+3.000000 ci95_low_pct=+1.000000 ci95_high_pct=+5.000000 " +
        "limit_pct=3.000000 verdict=pass",
    );
  });

  test("returns two when the point estimate exceeds the limit but its interval crosses", () => {
    const rows = completeRows(3);
    for (let index = 0; index < rows.length; index++) {
      const round = Math.floor(index / 4);
      if (rows[index]!.includes("label=candidate")) {
        rows[index] = rows[index]!.replace("median_us=101", `median_us=${101 + round * 3}`);
      }
    }
    const result = runAnalyzer(rows, { rounds: 3 });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain(
      "median_pct=+4.000000 ci95_low_pct=+1.000000 ci95_high_pct=+7.000000 " +
        "limit_pct=3.000000 verdict=inconclusive",
    );
    expect(result.stdout).toContain(
      "verdict=inconclusive failed_cases=0 inconclusive_cases=1 errors=0",
    );
  });
});
