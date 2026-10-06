#!/usr/bin/env bun
// tools/rpgkit-check/cli.ts — command-line entry for the rpgkit-check tools.
//
//   bun run rpgkit-check <check> --file <doc.json> [--json '<args>'] [--out <dir>]
//     [--session <module>] [--max-frames <n>] [--max-states <n>]
//     [--max-seconds <n>] [--map <id>] [--incremental]
//
// <check> is one of: lint, locks, freeze, reach, explore, shot (or the full
// rpgkit-<check> tool name). The report is printed to stdout as JSON. Exit
// code is 0 when the report has no error-severity findings, 1 when it does,
// and 2 for usage or load errors (a load error still prints its findings as
// a JSON report). The same tools are exposed as MCP descriptors in
// src/registry.ts for the editing server to mount.
//
// --map scopes a lint pass to one map (a shell loads only that shard).
// --incremental makes a shell lint reuse cached per-shard findings and
// re-check only changed shards.

import { CHECK_TOOLS, CheckArgsError, CheckLoadError, checkTool } from "./src/registry.ts";
import { countBySeverity, type CheckReport } from "./src/finding.ts";
import type { SessionOptions } from "../../src/engine/session.ts";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function usage(): never {
  console.error(
    `usage: bun tools/rpgkit-check/cli.ts <check> --file <doc.json> [--json '<args>'] [--out <dir>]\n` +
      `  [--session <module>]\n` +
      `  [--max-frames <n>] [--max-states <n>] [--max-seconds <n>] [--map <id>] [--incremental]\n` +
      `  [--goal <expr>]... [--goal-mode all|any] [--replay <witness-file>] [--fail-unmet]\n` +
      `checks: ${CHECK_TOOLS.map((t) => t.name.replace(/^rpgkit-/, "")).join(", ")}\n` +
      `note: reach reports a replayable witness for every reached map; a notFound map is a lead, not a proof.\n` +
      `note: reach budgets are execution limits: the search may run at most one 6-tick block past --max-frames.\n` +
      `note: reach --goal stops the search when the goals are met; --replay re-verifies a saved witness.\n` +
      `note: --fail-unmet exits 1 when a reach run's goals were not met within budget (for CI gates).`,
  );
  process.exit(2);
}

/** Parse a non-negative numeric budget flag (a hard usage error otherwise).
 *  `integer` flags (maxFrames, maxStates) also reject fractions, matching
 *  the registry's value domain so every entry point enforces the same
 *  range. */
function parseBudget(flag: string, value: string, integer = false): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    console.error(`${flag} must be a non-negative${integer ? " integer" : ""} number, got ${JSON.stringify(value)}`);
    usage();
  }
  return n;
}

const argv = process.argv.slice(2);
if (argv.length === 0) usage();

const checkName = argv[0]!;
let file: string | undefined;
let argsJson: string | undefined;
let out: string | undefined;
let sessionModule: string | undefined;
let maxFrames: number | undefined;
let maxStates: number | undefined;
let maxSeconds: number | undefined;
let map: string | undefined;
let incremental = false;
const goals: string[] = [];
let goalMode: "all" | "any" | undefined;
let replayFile: string | undefined;
let failUnmet = false;
for (let i = 1; i < argv.length; i++) {
  const arg = argv[i]!;
  // A flag must be followed by its value; a missing or empty value is a
  // usage error, not a silent ignore (an empty --json would otherwise be
  // treated as "no args" and exit 0).
  const takeValue = (flag: string): string => {
    const value = argv[++i];
    if (value === undefined || value === "" || value.startsWith("--")) {
      console.error(`${flag} requires a value`);
      usage();
    }
    return value;
  };
  // A `--flag=value` form with an empty value is the same usage error as a
  // missing value, not a silent empty string.
  const takeEquals = (flag: string, arg: string): string => {
    const value = arg.slice(arg.indexOf("=") + 1);
    if (value === "") {
      console.error(`${flag} requires a value`);
      usage();
    }
    return value;
  };
  if (arg === "--file") file = takeValue("--file");
  else if (arg === "--json" || arg === "--args") argsJson = takeValue(arg);
  else if (arg === "--out") out = takeValue("--out");
  else if (arg === "--session") sessionModule = takeValue("--session");
  else if (arg === "--max-frames") maxFrames = parseBudget("--max-frames", takeValue("--max-frames"), true);
  else if (arg === "--max-states") maxStates = parseBudget("--max-states", takeValue("--max-states"), true);
  else if (arg === "--max-seconds") maxSeconds = parseBudget("--max-seconds", takeValue("--max-seconds"));
  else if (arg === "--map") map = takeValue("--map");
  else if (arg === "--incremental") incremental = true;
  else if (arg === "--goal") goals.push(takeValue("--goal"));
  else if (arg === "--goal-mode") {
    const value = takeValue("--goal-mode");
    if (value !== "all" && value !== "any") {
      console.error(`--goal-mode must be all or any, got ${JSON.stringify(value)}`);
      usage();
    }
    goalMode = value;
  }
  else if (arg === "--replay") replayFile = takeValue("--replay");
  else if (arg === "--fail-unmet") failUnmet = true;
  else if (arg.startsWith("--file=")) file = takeEquals("--file", arg);
  else if (arg.startsWith("--json=") || arg.startsWith("--args=")) {
    argsJson = takeEquals(arg.startsWith("--json=") ? "--json" : "--args", arg);
  } else if (arg.startsWith("--out=")) out = takeEquals("--out", arg);
  else if (arg.startsWith("--session=")) sessionModule = takeEquals("--session", arg);
  else if (arg.startsWith("--max-frames=")) maxFrames = parseBudget("--max-frames", takeEquals("--max-frames", arg), true);
  else if (arg.startsWith("--max-states=")) maxStates = parseBudget("--max-states", takeEquals("--max-states", arg), true);
  else if (arg.startsWith("--max-seconds=")) maxSeconds = parseBudget("--max-seconds", takeEquals("--max-seconds", arg));
  else if (arg.startsWith("--map=")) map = takeEquals("--map", arg);
  else if (arg.startsWith("--goal=")) goals.push(takeEquals("--goal", arg));
  else if (arg.startsWith("--goal-mode=")) {
    const value = takeEquals("--goal-mode", arg);
    if (value !== "all" && value !== "any") {
      console.error(`--goal-mode must be all or any, got ${JSON.stringify(value)}`);
      usage();
    }
    goalMode = value;
  }
  else if (arg.startsWith("--replay=")) replayFile = takeEquals("--replay", arg);
  else {
    console.error(`unknown argument: ${arg}`);
    usage();
  }
}

if (!file) {
  console.error("missing --file <doc.json>");
  usage();
}

if (replayFile && checkName !== "reach" && checkName !== "reach-replay") {
  console.error("--replay only applies to reach");
  usage();
}
if ((goals.length > 0 || goalMode !== undefined) && checkName !== "reach" && checkName !== "reach-replay") {
  console.error("--goal/--goal-mode only apply to reach");
  usage();
}
if (failUnmet && checkName !== "reach") {
  console.error("--fail-unmet only applies to reach");
  usage();
}

const tool = checkTool(replayFile ? "reach-replay" : checkName);
if (!tool) {
  console.error(`unknown check: ${checkName}`);
  usage();
}

let extraArgs: Record<string, unknown> = {};
if (argsJson) {
  try {
    const encoded = argsJson.startsWith("@")
      ? readFileSync(resolve(dirname(resolve(file)), argsJson.slice(1)), "utf8")
      : argsJson;
    const parsed = JSON.parse(encoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error("--json must be a JSON object");
      process.exit(2);
    }
    extraArgs = parsed as Record<string, unknown>;
  } catch (err) {
    console.error(`invalid --json: ${String(err)}`);
    process.exit(2);
  }
}

// Explicit CLI flags win over the JSON args object: a --file on the command
// line can never be overridden by a "file" key inside --json.
const callArgs = replayFile
  ? {
      ...(goals.length > 0 ? { goals } : {}),
      ...(goalMode !== undefined ? { goalMode } : {}),
      file,
      witness: replayFile,
    }
  : {
      ...extraArgs,
      ...(out ? { out } : {}),
      ...(maxFrames !== undefined ? { maxFrames } : {}),
      ...(maxStates !== undefined ? { maxStates } : {}),
      ...(maxSeconds !== undefined ? { maxSeconds } : {}),
      ...(map !== undefined ? { map } : {}),
      ...(incremental ? { incremental: true } : {}),
      ...(goals.length > 0 ? { goals } : {}),
      ...(goalMode !== undefined ? { goalMode } : {}),
      file,
    };

async function loadSessionOptions(file: string): Promise<SessionOptions> {
  const href = pathToFileURL(resolve(process.cwd(), file)).href;
  const loaded = await import(href) as { default?: unknown; sessionOptions?: unknown };
  const value = loaded.default ?? loaded.sessionOptions;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`--session module must export a SessionOptions object as default or sessionOptions: ${file}`);
  }
  const options = value as Record<string, unknown>;
  const expectType = (
    key: string,
    valid: (candidate: unknown) => boolean,
    expected: string,
  ): void => {
    if (options[key] !== undefined && !valid(options[key])) {
      throw new Error(`--session module SessionOptions.${key} must be ${expected}: ${file}`);
    }
  };
  const isObject = (candidate: unknown): boolean =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
  expectType("immutableState", (candidate) => typeof candidate === "boolean", "a boolean");
  expectType("verifyMapManifest", (candidate) => typeof candidate === "boolean", "a boolean");
  expectType("maps", isObject, "an object");
  expectType("extensions", isObject, "an object");
  expectType("battle", isObject, "an object");
  expectType("scenes", isObject, "an object");
  expectType("scene", isObject, "an object");
  expectType("onFiberStart", (candidate) => typeof candidate === "function", "a function");
  expectType("paginateText", (candidate) => typeof candidate === "function", "a function");
  return value as SessionOptions;
}

try {
  if (sessionModule && tool.name === "rpgkit-lint") {
    throw new Error("--session applies to dynamic checks and shot, not lint");
  }
  const sessionOptions = sessionModule ? await loadSessionOptions(sessionModule) : undefined;
  const result = await tool.run(callArgs, sessionOptions ? { sessionOptions } : undefined);
  console.log(JSON.stringify(result, null, 2));
  const report = result as Partial<CheckReport>;
  // --fail-unmet: a goals run that spent its budget without meeting the goals
  // exits 1 so a CI gate can fail on an unmet goal without parsing JSON.
  if (failUnmet && (result as { goals?: { status?: string } }).goals?.status === "unmet") {
    console.error("reach goals were not met within budget (--fail-unmet)");
    process.exit(1);
  }
  if (Array.isArray(report.findings)) {
    const { error } = countBySeverity(report.findings);
    process.exit(error > 0 ? 1 : 0);
  }
  process.exit(0);
} catch (err) {
  if (err instanceof CheckLoadError) {
    // A load failure is still a structured report: the doc/* findings say
    // exactly what could not be read, so an agent can act on them.
    console.log(JSON.stringify({
      check: tool.name,
      findings: err.findings,
      summary: { loadError: 1 },
    } satisfies CheckReport, null, 2));
    process.exit(2);
  }
  if (err instanceof CheckArgsError) {
    console.error(`invalid args: ${err.message}`);
    process.exit(2);
  }
  console.error(String(err));
  process.exit(2);
}
