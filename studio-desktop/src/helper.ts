// studio-desktop/src/helper.ts — the Bun helper the Studio desktop shell
// spawns for everything that needs the kit's Bun-side tools: rpgkit-check's
// engine checks, RPG Maker imports and the local agent
// (tools/lib/editor-agent-companion.ts).
// It is compiled with `bun build --compile`, so it must not read kit files
// at run time; everything it needs is bundled into the executable.
//
//   rpgkit-studio-helper serve           JSON-lines protocol on stdin/stdout
//                                        (helper-protocol.ts); stdout carries
//                                        protocol lines only
//   rpgkit-studio-helper mcp --root <d>  the proposal-only rpgkit-edit MCP
//                                        server the agent launches
//   rpgkit-studio-helper check-once      one check run: project text on stdin,
//                                        {problems} or {error} JSON on stdout
//                                        (a child of `serve`, so a check can be
//                                        killed on timeout or cancel)
//   rpgkit-studio-helper import-once     one staged RPG Maker import: JSON
//                                        parameters on stdin, summary on stdout

import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { checkProblems, type StudioProblem } from "../../editor/studio/problems.ts";
import { loadProject } from "../../editor/engine/document.ts";
import { proposalSemanticHash } from "../../editor/proposals/model.ts";
import {
  LOCAL_AGENT_PROTOCOL,
  parseLocalAgentGuestMessage,
  type LocalAgentStart,
  type LocalAgentState,
} from "../../editor/agent/types.ts";
import { LocalAgentController, type LocalAgentControllerOptions } from "../../tools/lib/editor-agent-companion.ts";
import { runMcpServer } from "../../tools/rpgkit-edit/mcp.ts";
import { PROJECT_SCHEMA } from "../../tools/rpgkit-check/src/doc.ts";
import { lintProject } from "../../tools/rpgkit-check/src/lint.ts";
import { checkLocks } from "../../tools/rpgkit-check/src/dynamic/locks.ts";
import { checkFreeze } from "../../tools/rpgkit-check/src/dynamic/freeze.ts";
import { checkReach } from "../../tools/rpgkit-check/src/dynamic/reach.ts";
import type { Finding } from "../../tools/rpgkit-check/src/finding.ts";
import { validateSchema } from "../../src/engine/schema-validate.ts";
import type { Project } from "../../src/engine/types.ts";
import { importToDirectory } from "../../tools/rpgmaker-import/index.ts";
import {
  HELPER_EXIT_BAD_TOKEN,
  HELPER_PROTOCOL_VERSION,
  HELPER_TOKEN_ENV,
  parseHelperLine,
  type AgentParams,
  type AgentResult,
  type CancelResult,
  type CheckParams,
  type CheckResult,
  type ImportResult,
  type HelperErrorCode,
  type HelperOutput,
  type ProbeParams,
  type ProbeResult,
} from "./helper-protocol.ts";

const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
const MAX_CHECK_TIMEOUT_MS = 30 * 60_000;
const SHUTDOWN_GRACE_MS = 5_000;
const MAX_DETAIL_CHARS = 800;
const MAX_IMPORT_WARNINGS = 24;
const TERMINAL_STATES = new Set<LocalAgentState["status"]>(["completed", "failed", "cancelled", "timed-out"]);

/** A tiny valid project the probe hands to the agent controller, which needs
 * a real project file to resolve its working directory and MCP root. */
const PROBE_PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "Studio probe",
  tileSize: 16,
  start: { map: "probe", x: 0, y: 0, dir: "down" },
  sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
  items: [],
  maps: [{ id: "probe", name: "Probe", width: 1, height: 1, sheets: ["tiles"], ground: ["tiles.0"], events: [] }],
};

class HelperFailure extends Error {
  readonly code: HelperErrorCode;
  constructor(code: HelperErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARS);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** True inside a `bun build --compile` executable, where there is no kit
 * checkout and process.execPath is this helper rather than bun. */
export function isCompiledHelper(): boolean {
  return /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(Bun.main) ||
    !/^bun(\.exe)?$/i.test(basename(process.execPath));
}

/** argv that runs this helper again with a subcommand. */
function selfCommand(subcommand: string, ...args: string[]): string[] {
  return isCompiledHelper()
    ? [process.execPath, subcommand, ...args]
    : [process.execPath, Bun.main, subcommand, ...args];
}

/** The kit checkout when run from source. A compiled helper has none, so the
 * run's own directory stands in (only `{{repoRoot}}` templates and the
 * default config directory see it). */
function kitRoot(fallback: string): string {
  return isCompiledHelper() ? fallback : resolve(import.meta.dir, "..", "..");
}

/** A compiled helper is its own MCP server; from source the controller's
 * default (bun tools/rpgkit-edit/mcp.ts --proposal-only) applies. */
function mcpServer(): LocalAgentControllerOptions["mcpServer"] {
  if (!isCompiledHelper()) return undefined;
  return { command: process.execPath, args: (projectDir) => ["mcp", "--root", projectDir] };
}

function stringParam(params: Record<string, unknown>, key: string, optional = false): string | undefined {
  const value = params[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new HelperFailure("BAD_REQUEST", `params.${key} must be a non-empty string`);
  }
  return value;
}

function configParam(params: Record<string, unknown>): string | undefined {
  const path = stringParam(params, "agentConfig", true);
  if (path !== undefined && !isAbsolute(path)) {
    throw new HelperFailure("BAD_REQUEST", "params.agentConfig must be an absolute path");
  }
  return path;
}

// ---------------------------------------------------------------- checks

function findingProblem(finding: Finding): StudioProblem {
  return {
    severity: finding.severity,
    source: "check",
    message: `${finding.message}. ${finding.suggestion}`,
    code: finding.check,
    ...(finding.loc.map === undefined ? {} : { map: finding.loc.map }),
    ...(finding.loc.event === undefined ? {} : { event: finding.loc.event }),
    ...(finding.loc.page === undefined ? {} : { page: finding.loc.page }),
  };
}

/** rpgkit-check's static lint plus the dynamic locks, freeze and reach
 * checks over one inline project, as de-duplicated Studio problems. The
 * dynamic checks drive the engine, so they only run on a schema-valid
 * document (Studio already lists schema problems itself). */
export function runChecks(project: Project): StudioProblem[] {
  const problems = checkProblems(project);
  if (validateSchema(PROJECT_SCHEMA, project).length === 0) {
    const dynamic: [string, () => Finding[]][] = [
      ["rpgkit-locks", () => checkLocks(project).findings],
      ["rpgkit-freeze", () => checkFreeze(project).findings],
      ["rpgkit-reach", () => checkReach(project).findings],
    ];
    for (const [name, run] of dynamic) {
      try {
        problems.push(...run().map(findingProblem));
      } catch (error) {
        problems.push({ severity: "error", source: "check", code: name, message: `${name} could not run: ${errorText(error)}` });
      }
    }
  }
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = JSON.stringify([problem.severity, problem.code, problem.message, problem.map, problem.event, problem.page]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseInlineProject(text: string): Project {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new HelperFailure("BAD_REQUEST", `projectText is not valid JSON: ${errorText(error)}`);
  }
  const project = record(value);
  if (!project) throw new HelperFailure("BAD_REQUEST", "projectText must be a JSON object");
  if (!Array.isArray(project.maps)) {
    throw new HelperFailure("BAD_REQUEST", "projectText must be an inline rpgkit-project/v1 document (maps in the document)");
  }
  return project as unknown as Project;
}

async function checkOnce(): Promise<void> {
  let output: unknown;
  try {
    output = { problems: runChecks(parseInlineProject(await Bun.stdin.text())) } satisfies CheckResult;
  } catch (error) {
    const code = error instanceof HelperFailure ? error.code : "FAILED";
    output = { error: { code, message: errorText(error) } };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

interface CheckRun {
  child: Bun.Subprocess<Blob, "pipe", "pipe">;
  stop: "cancelled" | "timed-out" | null;
}

interface ImportRun {
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  stop: "cancelled" | null;
}

// ---------------------------------------------------------------- agent

interface AgentRun {
  controller: LocalAgentController;
  requestId: string;
  settled: boolean;
}

// ---------------------------------------------------------------- serve

class HelperServer {
  private readonly checks = new Map<string, CheckRun>();
  private readonly imports = new Map<string, ImportRun>();
  private readonly agents = new Map<string, AgentRun>();
  private readonly pending = new Set<Promise<void>>();
  private closing = false;

  write(message: HelperOutput): void {
    try {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      process.stderr.write(`rpgkit-studio-helper: cannot write to the main process: ${errorText(error)}\n`);
    }
  }

  dispatch(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
      process.stderr.write("rpgkit-studio-helper: ignoring a request without a numeric id\n");
      return;
    }
    const task = (async () => {
      try {
        const result = await this.call(message.method, record(message.params) ?? {});
        this.write({ id, ok: true, result });
      } catch (error) {
        const code = error instanceof HelperFailure ? error.code : "FAILED";
        this.write({ id, ok: false, error: { code, message: errorText(error) } });
      }
    })();
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private async call(method: unknown, params: Record<string, unknown>): Promise<unknown> {
    if (this.closing) throw new HelperFailure("CANCELLED", "The helper is shutting down.");
    switch (method) {
      case "probe": return this.probe(params as ProbeParams & Record<string, unknown>);
      case "check": return await this.check(params);
      case "import": return await this.importProject(params);
      case "agent": return await this.agent(params);
      case "cancel": return this.cancel(stringParam(params, "runId")!);
      default: throw new HelperFailure("BAD_REQUEST", `unknown method ${JSON.stringify(method)}`);
    }
  }

  private claimRunId(params: Record<string, unknown>): string {
    const runId = stringParam(params, "runId")!;
    if (this.checks.has(runId) || this.imports.has(runId) || this.agents.has(runId)) {
      throw new HelperFailure("BAD_REQUEST", `run ${JSON.stringify(runId)} is already active`);
    }
    return runId;
  }

  probe(params: ProbeParams & Record<string, unknown>): ProbeResult {
    const configFile = configParam(params);
    let agent: ProbeResult["agent"];
    const directory = mkdtempSync(join(tmpdir(), "rpgkit-studio-probe-"));
    try {
      const projectFile = join(directory, "project.json");
      writeFileSync(projectFile, `${JSON.stringify(PROBE_PROJECT)}\n`);
      const controller = new LocalAgentController({
        repoRoot: kitRoot(directory),
        projectFile,
        stateDirectory: join(directory, ".agent"),
        ...(configFile === undefined ? {} : { configFile }),
        mcpServer: mcpServer(),
        onMessage() {},
      });
      agent = { available: controller.ready.available, reason: controller.ready.message };
    } catch (error) {
      agent = { available: false, reason: errorText(error) };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    let checks: ProbeResult["checks"];
    try {
      lintProject(PROBE_PROJECT);
      checks = { available: true, reason: "rpgkit-check lint, locks, freeze and reach are built in." };
    } catch (error) {
      checks = { available: false, reason: errorText(error) };
    }
    return { agent, checks };
  }

  private async check(params: Record<string, unknown>): Promise<CheckResult> {
    const runId = this.claimRunId(params);
    const projectText = params.projectText;
    if (typeof projectText !== "string") throw new HelperFailure("BAD_REQUEST", "params.projectText must be a string");
    const timeoutMs = params.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CHECK_TIMEOUT_MS) {
      throw new HelperFailure("BAD_REQUEST", `params.timeoutMs must be an integer from 1 to ${MAX_CHECK_TIMEOUT_MS}`);
    }
    const child = Bun.spawn({
      cmd: selfCommand("check-once"),
      stdin: new Blob([projectText]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const run: CheckRun = { child, stop: null };
    this.checks.set(runId, run);
    const timer = setTimeout(() => this.stopCheck(run, "timed-out"), timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (run.stop === "cancelled") throw new HelperFailure("CANCELLED", "Checks cancelled.");
      if (run.stop === "timed-out") throw new HelperFailure("TIMED_OUT", `Checks timed out after ${timeoutMs} ms.`);
      const reply = record(parseHelperLine(stdout.trim().split("\n").pop() ?? ""));
      if (exitCode !== 0 || !reply) {
        throw new HelperFailure("FAILED", `Checks failed: ${compact(stderr) || `exit ${exitCode}`}`);
      }
      const error = record(reply.error);
      if (error) throw new HelperFailure(error.code === "BAD_REQUEST" ? "BAD_REQUEST" : "FAILED", String(error.message));
      if (!Array.isArray(reply.problems)) throw new HelperFailure("FAILED", "Checks returned no problem list.");
      return { problems: reply.problems as StudioProblem[] };
    } finally {
      clearTimeout(timer);
      this.checks.delete(runId);
    }
  }

  private stopCheck(run: CheckRun, reason: "cancelled" | "timed-out"): void {
    if (run.stop) return;
    run.stop = reason;
    run.child.kill("SIGKILL");
  }

  private async importProject(params: Record<string, unknown>): Promise<ImportResult> {
    const runId = this.claimRunId(params);
    const sourceDir = stringParam(params, "sourceDir")!;
    const outputDir = stringParam(params, "outputDir")!;
    const placeholders = params.placeholders;
    if (!isAbsolute(sourceDir)) throw new HelperFailure("BAD_REQUEST", "params.sourceDir must be an absolute path");
    if (!isAbsolute(outputDir)) throw new HelperFailure("BAD_REQUEST", "params.outputDir must be an absolute path");
    if (placeholders !== "visible" && placeholders !== "silent") {
      throw new HelperFailure("BAD_REQUEST", "params.placeholders must be visible or silent");
    }
    try {
      if (!statSync(sourceDir).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new HelperFailure("BAD_REQUEST", "params.sourceDir must be an existing directory");
    }
    try {
      if (!statSync(outputDir).isDirectory() || readdirSync(outputDir).length > 0) throw new Error("not empty");
    } catch {
      throw new HelperFailure("BAD_REQUEST", "params.outputDir must be an existing empty directory");
    }

    this.write({
      event: "import-progress",
      runId,
      phase: "converting",
      message: "Converting maps, events, art and audio / 正在转换地图、事件、美术和音频",
    });
    const child = Bun.spawn({
      cmd: selfCommand("import-once"),
      stdin: new Blob([JSON.stringify({ sourceDir, outputDir, placeholders })]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const run: ImportRun = { child, stop: null };
    this.imports.set(runId, run);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (run.stop === "cancelled") throw new HelperFailure("CANCELLED", "Import cancelled / 已取消导入");
      const reply = record(parseHelperLine(stdout.trim().split("\n").pop() ?? ""));
      if (exitCode !== 0 || !reply) {
        throw new HelperFailure("FAILED", `RPG Maker import failed / RPG Maker 导入失败: ${compact(stderr) || `exit ${exitCode}`}`);
      }
      const error = record(reply.error);
      if (error) throw new HelperFailure("FAILED", String(error.message));
      const result = record(reply.result);
      const coverage = record(result?.coverage);
      if (!result || !coverage || !record(coverage.totals) || !Array.isArray(coverage.rows) || !Array.isArray(result.warnings)) {
        throw new HelperFailure("FAILED", "RPG Maker importer returned an invalid summary / RPG Maker 导入器返回了无效摘要");
      }
      return result as unknown as ImportResult;
    } finally {
      this.imports.delete(runId);
    }
  }

  private async agent(params: Record<string, unknown>): Promise<AgentResult> {
    const runId = this.claimRunId(params);
    const prompt = stringParam(params, "prompt")!;
    const configFile = configParam(params);
    const workDir = stringParam(params, "workDir")!;
    const projectText = params.projectText;
    if (typeof projectText !== "string") throw new HelperFailure("BAD_REQUEST", "params.projectText must be a string");
    // The helper deletes workDir when the run ends, so it only accepts the
    // empty scratch directory the main process just made for this run.
    if (!isAbsolute(workDir)) throw new HelperFailure("BAD_REQUEST", "params.workDir must be an absolute path");
    try {
      if (!statSync(workDir).isDirectory() || readdirSync(workDir).length > 0) throw new Error("not empty");
    } catch {
      throw new HelperFailure("BAD_REQUEST", "params.workDir must be an existing empty directory");
    }

    let run: AgentRun | null = null;
    try {
      const loaded = loadProject(projectText);
      if (loaded.errors.length > 0) {
        throw new HelperFailure("FAILED", `The project is invalid: ${loaded.errors[0]!.path} ${loaded.errors[0]!.msg}`);
      }
      const start: LocalAgentStart = {
        t: "agent-start",
        protocol: LOCAL_AGENT_PROTOCOL,
        id: randomBytes(32).toString("hex"),
        request: prompt,
        projectHash: proposalSemanticHash(loaded.project),
        context: params.context as LocalAgentStart["context"],
      };
      if (!parseLocalAgentGuestMessage(start)) {
        throw new HelperFailure("BAD_REQUEST", "params.prompt is too long or params.context is not a valid editor context");
      }
      const projectFile = join(workDir, "project.json");
      writeFileSync(projectFile, projectText);
      mkdirSync(join(workDir, ".agent"), { recursive: true });

      let proposals: unknown[] = [];
      let settle!: (state: LocalAgentState) => void;
      const terminal = new Promise<LocalAgentState>((resolveTerminal) => { settle = resolveTerminal; });
      const controller = new LocalAgentController({
        repoRoot: kitRoot(workDir),
        projectFile,
        stateDirectory: join(workDir, ".agent"),
        ...(configFile === undefined ? {} : { configFile }),
        mcpServer: mcpServer(),
        onMessage: (message) => {
          if (message.t === "proposals") {
            proposals = message.proposals;
            return;
          }
          if (message.t !== "agent-state" || message.id !== start.id || !run || run.settled) return;
          this.write({ event: "agent-state", runId, status: message.status, message: message.message });
          if (TERMINAL_STATES.has(message.status)) {
            run.settled = true;
            settle(message);
          }
        },
      });
      if (!controller.ready.available) throw new HelperFailure("UNAVAILABLE", controller.ready.message);
      run = { controller, requestId: start.id, settled: false };
      this.agents.set(runId, run);
      controller.handle(start);
      const final = await terminal;
      if (final.status === "cancelled") throw new HelperFailure("CANCELLED", final.message);
      if (final.status === "timed-out") throw new HelperFailure("TIMED_OUT", final.message);
      if (final.status !== "completed") throw new HelperFailure("FAILED", final.message);
      const created = new Set(final.proposalIds ?? []);
      return {
        proposals: proposals
          .filter((proposal) => created.has(String(record(proposal)?.id)))
          .map((proposal) => JSON.stringify(proposal)),
      };
    } finally {
      if (run) await run.controller.close();
      this.agents.delete(runId);
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  cancel(runId: string): CancelResult {
    const check = this.checks.get(runId);
    if (check && !check.stop) {
      this.stopCheck(check, "cancelled");
      return { cancelled: true };
    }
    const importing = this.imports.get(runId);
    if (importing && !importing.stop) {
      importing.stop = "cancelled";
      importing.child.kill("SIGKILL");
      return { cancelled: true };
    }
    const agent = this.agents.get(runId);
    if (agent && !agent.settled) {
      agent.controller.cancel(agent.requestId);
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  /** Stop every run and wait (bounded) for their replies and cleanup. */
  async close(): Promise<void> {
    this.closing = true;
    for (const run of this.checks.values()) this.stopCheck(run, "cancelled");
    for (const run of this.imports.values()) {
      if (!run.stop) {
        run.stop = "cancelled";
        run.child.kill("SIGKILL");
      }
    }
    for (const run of this.agents.values()) {
      if (!run.settled) run.controller.cancel(run.requestId);
    }
    await Promise.race([Promise.allSettled([...this.pending]), Bun.sleep(SHUTDOWN_GRACE_MS)]);
  }
}

async function importOnce(): Promise<void> {
  let output: unknown;
  try {
    const input = record(JSON.parse(await Bun.stdin.text()));
    if (!input) throw new Error("request must be a JSON object");
    const sourceDir = input.sourceDir;
    const outputDir = input.outputDir;
    const placeholders = input.placeholders;
    if (typeof sourceDir !== "string" || typeof outputDir !== "string" ||
      (placeholders !== "visible" && placeholders !== "silent")) {
      throw new Error("request needs sourceDir, outputDir and placeholders");
    }
    if (!isAbsolute(sourceDir) || !statSync(sourceDir).isDirectory()) {
      throw new Error("sourceDir must be an existing absolute directory");
    }
    if (!isAbsolute(outputDir) || !statSync(outputDir).isDirectory() || readdirSync(outputDir).length > 0) {
      throw new Error("outputDir must be an existing empty absolute directory");
    }
    const imported = await importToDirectory(sourceDir, outputDir, { shard: true, placeholders });
    const limitationRows = imported.cov.list()
      .filter((row) => row.counts.Placeholder > 0 || row.counts.Dropped > 0);
    const warnings = imported.warnings.slice(0, MAX_IMPORT_WARNINGS);
    if (imported.warnings.length > warnings.length) {
      warnings.push(`… ${imported.warnings.length - warnings.length} more warnings; see coverage.md / 另有 ${imported.warnings.length - warnings.length} 条警告，请查看 coverage.md`);
    }
    output = {
      result: {
        coverage: {
          totals: imported.cov.totals("command"),
          rows: limitationRows,
        },
        warnings,
      } satisfies ImportResult,
    };
  } catch (error) {
    output = { error: { message: `RPG Maker import failed / RPG Maker 导入失败: ${errorText(error)}` } };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function tokensMatch(given: string, expected: string): boolean {
  // Hashing first gives equal-length inputs, so the comparison time does not
  // depend on where (or whether) the lengths differ.
  const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function exitBadToken(reason: string): never {
  process.stderr.write(`rpgkit-studio-helper: ${reason}\n`);
  process.exit(HELPER_EXIT_BAD_TOKEN);
}

async function serve(): Promise<void> {
  const expected = process.env[HELPER_TOKEN_ENV];
  delete process.env[HELPER_TOKEN_ENV];
  if (!expected) exitBadToken(`${HELPER_TOKEN_ENV} is not set`);
  // stdout is the protocol channel: route stray library logging to stderr.
  console.log = console.info = console.debug = console.error;

  const server = new HelperServer();
  let greeted = false;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  process.stdout.on("error", () => void stop());

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (!greeted) {
      if (line.trim() === "") continue;
      const hello = parseHelperLine(line);
      if (!hello || typeof hello.hello !== "string" || !tokensMatch(hello.hello, expected)) {
        exitBadToken("hello token mismatch");
      }
      greeted = true;
      server.write({ hello: "ok", version: HELPER_PROTOCOL_VERSION });
      continue;
    }
    const message = parseHelperLine(line);
    if (message) server.dispatch(message);
  }
  if (!greeted) exitBadToken("stdin closed before the hello");
  await stop();
}

function usage(): never {
  process.stderr.write("usage: rpgkit-studio-helper serve | mcp --root <project-directory> | check-once | import-once\n");
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "serve" && rest.length === 0) return await serve();
  if (command === "check-once" && rest.length === 0) return await checkOnce();
  if (command === "import-once" && rest.length === 0) return await importOnce();
  if (command === "mcp") {
    let root: string | undefined;
    if (rest[0] === "--root" && rest.length === 2) root = rest[1];
    else if (rest.length === 1 && rest[0]!.startsWith("--root=")) root = rest[0]!.slice("--root=".length);
    if (!root) usage();
    return await runMcpServer(root, "proposal-only");
  }
  usage();
}

if (import.meta.main) await main(process.argv.slice(2));
