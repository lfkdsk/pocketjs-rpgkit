// tests/rpgkit-check-cli.test.ts — the CLI: JSON output, exit codes, and the
// MCP registry descriptors.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_TOOLS, checkTool } from "../tools/rpgkit-check/src/registry.ts";

const CLI = join(import.meta.dir, "..", "tools", "rpgkit-check", "cli.ts");
const SUNSTONE = join(import.meta.dir, "..", "examples", "sunstone", "data", "sunstone.json");
const MEADOW = join(import.meta.dir, "..", "examples", "meadow", "data", "meadow.json");
const SESSION_PROJECT = join(import.meta.dir, "fixtures", "rpgkit-check", "session-project.json");
const SESSION_OPTIONS = join(import.meta.dir, "fixtures", "rpgkit-check", "session-options.ts");
const FREEZE_SESSION_PROJECT = join(import.meta.dir, "fixtures", "rpgkit-check", "session-freeze-project.json");
const FREEZE_SESSION_OPTIONS = join(import.meta.dir, "fixtures", "rpgkit-check", "session-options-freeze.ts");
const SESSION_NO_EXPORT = join(import.meta.dir, "fixtures", "rpgkit-check", "session-options-no-export.ts");
const SESSION_BAD_EXPORT = join(import.meta.dir, "fixtures", "rpgkit-check", "session-options-bad-export.ts");
const SESSION_BAD_EXTENSIONS = join(import.meta.dir, "fixtures", "rpgkit-check", "session-options-bad-extensions.ts");
const TEMP = join(import.meta.dir, `.rpgkit-check-cli-tmp-${process.pid}`);

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("rpgkit-check CLI", () => {
  test("lint on sunstone: clean, exit 0, JSON report", async () => {
    const { code, stdout, stderr } = await runCli(["lint", "--file", SUNSTONE]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout);
    expect(report.check).toBe("lint");
    expect(report.findings).toEqual([]);
    expect(report.summary.maps).toBe(3);
  });

  test("explore on meadow: complete, exit 0", async () => {
    const { code, stdout } = await runCli(["explore", "--file", MEADOW]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.check).toBe("explore");
    expect(report.summary.endedReason).toBe("complete");
    expect(report.summary.eventsNeverTriggered).toBe(0);
  });

  test("short and full tool names both resolve", async () => {
    const a = await runCli(["rpgkit-lint", "--file", SUNSTONE]);
    const b = await runCli(["lint", "--file", SUNSTONE]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  test("unknown check exits 2", async () => {
    const { code, stderr } = await runCli(["nope", "--file", SUNSTONE]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown check");
  });

  test("missing --file exits 2", async () => {
    const { code } = await runCli(["lint"]);
    expect(code).toBe(2);
  });

  test("a broken document exits 1 with findings", async () => {
    const { code, stdout, stderr } = await runCli([
      "lint",
      "--file",
      join(import.meta.dir, "..", "tests", "fixtures", "rpgkit-check", "broken.json"),
    ]);
    expect(code).toBe(1);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout);
    const ids = report.findings.map((f: { check: string }) => f.check);
    expect(ids).toContain("lint/transfer-target-missing");
    expect(ids).toContain("lint/choices-empty");
  });

  test("--json passes args and is the documented form", async () => {
    const { code, stdout } = await runCli(["lint", "--file", SUNSTONE, "--json", "{}"]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.check).toBe("lint");
  });

  test("--json @path resolves next to --file, not the process cwd", async () => {
    const file = join(TEMP, "project.json");
    writeFileSync(file, readFileSync(SUNSTONE));
    writeFileSync(join(TEMP, "args.json"), "{}\n");
    const { code, stdout, stderr } = await runCli([
      "lint", "--file", file, "--json", "@args.json",
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).check).toBe("lint");
  });

  test("--json with a key the inputSchema forbids exits 2", async () => {
    const { code, stderr } = await runCli(["lint", "--file", SUNSTONE, "--json", '{"bogus":1}']);
    expect(code).toBe(2);
    expect(stderr).toContain("invalid args");
  });

  test("--file on the command line wins over a file key in --json", async () => {
    // The JSON names a broken fixture; the explicit --file must win.
    const broken = join(import.meta.dir, "..", "tests", "fixtures", "rpgkit-check", "broken.json");
    const { code, stdout } = await runCli([
      "lint",
      "--file",
      SUNSTONE,
      "--json",
      JSON.stringify({ file: broken }),
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.findings).toEqual([]);
  });

  test("--json without a value exits 2", async () => {
    const { code, stderr } = await runCli(["lint", "--file", SUNSTONE, "--json"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--json requires a value");
  });

  test("--json= with an empty value exits 2", async () => {
    const { code, stderr } = await runCli(["lint", "--file", SUNSTONE, "--json="]);
    expect(code).toBe(2);
    expect(stderr).toContain("--json requires a value");
  });

  test("--args= with an empty value exits 2", async () => {
    const { code, stderr } = await runCli(["lint", "--file", SUNSTONE, "--args="]);
    expect(code).toBe(2);
    expect(stderr).toContain("--args requires a value");
  });

  test("--json '' (separate empty arg) exits 2", async () => {
    const { code, stderr } = await runCli(["lint", "--file", SUNSTONE, "--json", ""]);
    expect(code).toBe(2);
    expect(stderr).toContain("--json requires a value");
  });

  test("--file '' (separate empty arg) exits 2", async () => {
    const { code, stderr } = await runCli(["lint", "--file", ""]);
    expect(code).toBe(2);
    expect(stderr).toContain("--file requires a value");
  });

  test("--out '' (separate empty arg) exits 2", async () => {
    const { code, stderr } = await runCli(["lint", "--file", SUNSTONE, "--out", ""]);
    expect(code).toBe(2);
    expect(stderr).toContain("--out requires a value");
  });

  test("--session loads function-bearing TypeScript options for a dynamic check", async () => {
    const without = await runCli([
      "reach", "--file", SESSION_PROJECT,
      "--max-frames", "600", "--max-states", "30", "--max-seconds", "5",
    ]);
    const withSession = await runCli([
      "reach", "--file", SESSION_PROJECT,
      `--session=${SESSION_OPTIONS}`,
      "--max-frames", "600", "--max-states", "30", "--max-seconds", "5",
    ]);
    expect(without.code).toBe(0);
    expect(withSession.code).toBe(0);
    expect(JSON.parse(without.stdout).notFoundMaps).toContain("m2");
    const withReport = JSON.parse(withSession.stdout);
    expect(withReport.reachableMaps).toContain("m2");
    expect(withReport.assumptions.join("\n")).toContain("loaded session module");
  });

  test("freeze receives a named sessionOptions export from --session", async () => {
    const without = await runCli([
      "freeze", "--file", FREEZE_SESSION_PROJECT, "--json", '{"windowFrames":30}',
    ]);
    const withSession = await runCli([
      "freeze", "--file", FREEZE_SESSION_PROJECT, "--session", FREEZE_SESSION_OPTIONS,
      "--json", '{"windowFrames":30}',
    ]);
    expect(without.code).toBe(0);
    expect(JSON.parse(without.stdout).summary.flagged).toBe(0);
    expect(withSession.code).toBe(1);
    const report = JSON.parse(withSession.stdout);
    expect(report.summary.permanentLocks).toBe(1);
    expect(report.findings[0].check).toBe("freeze/permanent-lock");
  });

  test("explore receives default-exported sessionOptions from --session", async () => {
    const without = await runCli([
      "explore", "--file", SESSION_PROJECT, "--json", '{"frames":600,"stuckFrames":200}',
    ]);
    const withSession = await runCli([
      "explore", "--file", SESSION_PROJECT, "--session", SESSION_OPTIONS,
      "--json", '{"frames":600,"stuckFrames":200}',
    ]);
    expect(without.code).toBe(0);
    expect(JSON.parse(without.stdout).mapsVisited).toEqual(["m1"]);
    expect(withSession.code).toBe(0);
    const report = JSON.parse(withSession.stdout);
    expect(report.mapsVisited).toEqual(["m1", "m2"]);
    expect(report.summary.eventsNeverTriggered).toBe(0);
  });

  test("--session without a value exits 2", async () => {
    const { code, stderr } = await runCli(["reach", "--file", SESSION_PROJECT, "--session"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--session requires a value");
  });

  test("--session= with an empty value exits 2", async () => {
    const { code, stderr } = await runCli(["reach", "--file", SESSION_PROJECT, "--session="]);
    expect(code).toBe(2);
    expect(stderr).toContain("--session requires a value");
  });

  test("a missing --session module exits 2", async () => {
    const { code, stderr } = await runCli([
      "reach",
      "--file",
      SESSION_PROJECT,
      "--session",
      join(import.meta.dir, "fixtures", "rpgkit-check", "missing-session.ts"),
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("Cannot find module");
  });

  test("a --session module with no supported export exits 2", async () => {
    const { code, stderr } = await runCli([
      "explore", "--file", SESSION_PROJECT, "--session", SESSION_NO_EXPORT,
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("must export a SessionOptions object as default or sessionOptions");
  });

  test("a --session module whose exported value has the wrong type exits 2", async () => {
    const { code, stderr } = await runCli([
      "explore", "--file", SESSION_PROJECT, "--session", SESSION_BAD_EXPORT,
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("must export a SessionOptions object as default or sessionOptions");
  });

  test("a --session module with a malformed option type exits 2", async () => {
    const { code, stderr } = await runCli([
      "freeze", "--file", FREEZE_SESSION_PROJECT, "--session", SESSION_BAD_EXTENSIONS,
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("SessionOptions.extensions must be an object");
  });

  test("lint rejects --session instead of silently ignoring it", async () => {
    const { code, stderr } = await runCli(["lint", "--file", SESSION_PROJECT, "--session", SESSION_OPTIONS]);
    expect(code).toBe(2);
    expect(stderr).toContain("not lint");
  });

  test("an unreadable file exits 2 with a JSON report of doc findings", async () => {
    const { code, stdout, stderr } = await runCli(["lint", "--file", join(import.meta.dir, "no-such.json")]);
    expect(code).toBe(2);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout);
    expect(report.summary.loadError).toBe(1);
    expect(report.findings[0].check).toBe("doc/unreadable");
  });
});

describe("rpgkit-check CLI reach budget flags", () => {
  test("--max-frames 1 ends on the frame budget", async () => {
    const { code, stdout } = await runCli(["reach", "--file", MEADOW, "--max-frames", "1"]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.endedReason).toBe("frame-budget");
    // One block (6 ticks) is the minimum unit of work.
    expect(report.summary.framesRun).toBeGreaterThan(0);
    expect(report.summary.framesRun).toBeLessThanOrEqual(12);
  });

  test("--max-seconds 0.001 ends on the time budget", async () => {
    const { code, stdout } = await runCli(["reach", "--file", MEADOW, "--max-seconds", "0.001"]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.endedReason).toBe("time-budget");
  });

  test("--max-states 1 ends on the state budget", async () => {
    const { code, stdout } = await runCli(["reach", "--file", MEADOW, "--max-states", "1"]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.endedReason).toBe("state-budget");
  });

  test("--max-frames=1 (= form) is parsed", async () => {
    const { code, stdout } = await runCli(["reach", "--file", MEADOW, "--max-frames=1"]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.endedReason).toBe("frame-budget");
  });

  test("a non-numeric --max-frames exits 2", async () => {
    const { code, stderr } = await runCli(["reach", "--file", MEADOW, "--max-frames", "abc"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--max-frames must be a non-negative integer number");
  });

  test("--max-frames without a value exits 2", async () => {
    const { code, stderr } = await runCli(["reach", "--file", MEADOW, "--max-frames"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--max-frames requires a value");
  });

  test("a CLI budget flag wins over the same key in --json", async () => {
    const { code, stdout } = await runCli([
      "reach", "--file", MEADOW,
      "--json", JSON.stringify({ maxFrames: 100000 }),
      "--max-frames", "1",
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.endedReason).toBe("frame-budget");
    // One 6-tick block is the minimum unit of work, and the search never
    // runs more than one block past the budget.
    expect(report.summary.framesRun).toBeLessThanOrEqual(7);
  });
});

describe("rpgkit-check CLI reach --json value domains", () => {
  test("--json hz is rejected (witnesses verify at 60 Hz only)", async () => {
    const { code, stderr } = await runCli(["reach", "--file", MEADOW, "--json", JSON.stringify({ hz: 20 })]);
    expect(code).toBe(2);
    expect(stderr).toContain("hz");
  });

  test("--json maxFrames negative exits 2", async () => {
    const { code, stderr } = await runCli(["reach", "--file", MEADOW, "--json", JSON.stringify({ maxFrames: -1 })]);
    expect(code).toBe(2);
    expect(stderr).toContain("maxFrames");
  });

  test("--json maxStates fractional exits 2", async () => {
    const { code, stderr } = await runCli(["reach", "--file", MEADOW, "--json", JSON.stringify({ maxStates: 1.5 })]);
    expect(code).toBe(2);
    expect(stderr).toContain("maxStates");
  });

  test("--json maxSeconds fractional is accepted", async () => {
    const { code, stdout } = await runCli(["reach", "--file", MEADOW, "--json", JSON.stringify({ maxSeconds: 0.001 })]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.endedReason).toBe("time-budget");
  });

  test("--json battle is rejected (rules are code, not JSON)", async () => {
    const { code, stderr } = await runCli(["reach", "--file", MEADOW, "--json", JSON.stringify({ battle: {} })]);
    expect(code).toBe(2);
    expect(stderr).toContain("battle");
  });
});

describe("rpgkit-check MCP registry", () => {
  test("every tool has name, description, inputSchema, run", () => {
    expect(CHECK_TOOLS.length).toBeGreaterThanOrEqual(6);
    for (const tool of CHECK_TOOLS) {
      expect(tool.name).toMatch(/^rpgkit-/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.required).toContain("file");
      expect(typeof tool.run).toBe("function");
    }
  });

  test("checkTool resolves short and long names", () => {
    expect(checkTool("lint")?.name).toBe("rpgkit-lint");
    expect(checkTool("rpgkit-lint")?.name).toBe("rpgkit-lint");
    expect(checkTool("nope")).toBeUndefined();
  });

  test("registry tools run on sunstone", async () => {
    const lint = checkTool("lint")!;
    const report = (await lint.run({ file: SUNSTONE })) as { findings: unknown[] };
    expect(report.findings).toEqual([]);
  });

  test("registry run validates args against its own inputSchema", async () => {
    const lint = checkTool("lint")!;
    await expect(lint.run({ file: SUNSTONE, bogus: 1 } as never)).rejects.toThrow(/invalid args|bogus/);
    await expect(lint.run({} as never)).rejects.toThrow();
  });
});
