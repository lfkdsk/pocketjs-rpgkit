import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { proposalSemanticHash } from "../editor/proposals/model.ts";
import {
  HELPER_PROTOCOL_VERSION,
  parseHelperLine,
  type AgentStateEvent,
  type HelperResponse,
  type ImportProgressEvent,
  type ImportResult,
} from "../studio-desktop/src/helper-protocol.ts";

const ROOT = resolve(import.meta.dir, "..");
const TEMP = join(import.meta.dir, `.studio-desktop-helper-${process.pid}`);
const HELPER = join(ROOT, "studio-desktop", "src", "helper.ts");
const SOURCE = join(ROOT, "examples", "sunstone", "data", "sunstone.json");
const FAKE = join(import.meta.dir, "fixtures", "fake-local-agent.ts");
const RPG_MAKER = join(import.meta.dir, "fixtures", "rpgmaker", "hollow-mz");
const TOKEN = "ab".repeat(32);
const PROJECT_TEXT = readFileSync(SOURCE, "utf8");
const CONTEXT = {
  map: { id: "village", name: "Bramble Hollow", width: 20, height: 13 },
  selectedCell: { mapId: "village", x: 8, y: 5 },
  selectedEvent: { id: "elder", name: "Village Elder", x: 9, y: 5, w: 1, h: 1, page: 0 },
};

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function scratch(): string {
  const path = join(TEMP, randomUUID());
  mkdirSync(path, { recursive: true });
  return path;
}

function agentConfig(
  mode: "success" | "hang" | "fail" | "tree",
  options: { timeoutMs?: number; env?: Record<string, string>; command?: string[] } = {},
): string {
  const path = join(scratch(), "agent.json");
  writeFileSync(path, `${JSON.stringify({
    adapter: "custom",
    name: "offline fake",
    command: options.command ?? [process.execPath, FAKE],
    mcpRegistration: "claude-json",
    workingDirectory: "{{projectDir}}",
    timeoutMs: options.timeoutMs ?? 10_000,
    env: { FAKE_AGENT_MODE: mode, ...options.env },
  }, null, 2)}\n`);
  return path;
}

function processGroupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForFile(path: string, timeoutMs = 7_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

/** A helper child driven over its real stdio, as the main process does. */
class HelperProcess {
  readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly lines: Record<string, unknown>[] = [];
  readonly stderr: Promise<string>;
  private nextId = 1;

  constructor(command: string[], token: string | null = TOKEN, env: Record<string, string> = {}) {
    this.child = Bun.spawn({
      cmd: command,
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...env,
        ...(token === null ? {} : { RPGKIT_HELPER_TOKEN: token }),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.stderr = new Response(this.child.stderr).text();
    void this.read();
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = this.child.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = parseHelperLine(line);
        if (!message) throw new Error(`helper wrote a non-protocol line: ${line}`);
        this.lines.push(message);
      }
    }
  }

  send(value: unknown): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
    this.child.stdin.flush();
  }

  async waitFor(predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.lines.find(predicate);
      if (found) return found;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for helper output: ${JSON.stringify(this.lines)}`);
      await Bun.sleep(10);
    }
  }

  async hello(): Promise<void> {
    this.send({ hello: TOKEN });
    expect(await this.waitFor((message) => message.hello !== undefined)).toEqual({ hello: "ok", version: HELPER_PROTOCOL_VERSION });
  }

  call(method: string, params: Record<string, unknown>): { id: number; response: Promise<HelperResponse> } {
    const id = this.nextId++;
    this.send({ id, method, params });
    return { id, response: this.waitFor((message) => message.id === id, 60_000) as Promise<unknown> as Promise<HelperResponse> };
  }

  async request(method: string, params: Record<string, unknown>): Promise<HelperResponse> {
    return await this.call(method, params).response;
  }

  events(runId: string): AgentStateEvent[] {
    return this.lines.filter((message) => message.event === "agent-state" && message.runId === runId) as unknown as AgentStateEvent[];
  }

  importEvents(runId: string): ImportProgressEvent[] {
    return this.lines.filter((message) => message.event === "import-progress" && message.runId === runId) as unknown as ImportProgressEvent[];
  }

  async close(): Promise<number> {
    this.child.stdin.end();
    return await this.child.exited;
  }
}

async function started(
  command = [process.execPath, HELPER, "serve"],
  env: Record<string, string> = {},
): Promise<HelperProcess> {
  const helper = new HelperProcess(command, TOKEN, env);
  await helper.hello();
  return helper;
}

function result<R>(response: HelperResponse): R {
  if (!response.ok) throw new Error(`helper error ${response.error.code}: ${response.error.message}`);
  return response.result as R;
}

function errorCode(response: HelperResponse): string {
  if (response.ok) throw new Error(`expected an error, got ${JSON.stringify(response.result)}`);
  return response.error.code;
}

function brokenProject(): string {
  const project = JSON.parse(PROJECT_TEXT);
  const walk = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(walk);
    if (value === null || typeof value !== "object") return false;
    const node = value as Record<string, unknown>;
    if (node.op === "transfer" && typeof node.map === "string") {
      node.map = "nowhere";
      return true;
    }
    return Object.values(node).some(walk);
  };
  expect(walk(project.maps)).toBe(true);
  return JSON.stringify(project);
}

function agentParams(workDir: string, configFile: string, runId = randomUUID()) {
  return { runId, prompt: "Brighten the selected tile", projectText: PROJECT_TEXT, context: CONTEXT, agentConfig: configFile, workDir };
}

async function expectProposalRun(helper: HelperProcess): Promise<void> {
  const workDir = scratch();
  const params = agentParams(workDir, agentConfig("success"));
  const { proposals } = result<{ proposals: string[] }>(await helper.request("agent", params));
  expect(proposals).toHaveLength(1);
  const proposal = JSON.parse(proposals[0]!) as { id: string; baseHash: string };
  expect(proposal.id.startsWith("fake-")).toBe(true);
  expect(proposal.baseHash).toBe(proposalSemanticHash(JSON.parse(PROJECT_TEXT)));
  expect(helper.events(params.runId).map((event) => event.status)).toEqual(["starting", "running", "completed"]);
  expect(existsSync(workDir)).toBe(false);
}

describe("studio desktop helper", () => {
  test("exits 2 on a wrong or missing hello token", async () => {
    const wrong = new HelperProcess([process.execPath, HELPER, "serve"]);
    wrong.send({ hello: "cd".repeat(32) });
    expect(await wrong.child.exited).toBe(2);
    expect(wrong.lines).toEqual([]);

    const missing = new HelperProcess([process.execPath, HELPER, "serve"], null);
    missing.send({ hello: TOKEN });
    expect(await missing.child.exited).toBe(2);

    const junk = new HelperProcess([process.execPath, HELPER, "serve"]);
    junk.send("not a hello");
    expect(await junk.child.exited).toBe(2);
  });

  test("answers unknown methods with BAD_REQUEST and exits 0 on stdin EOF", async () => {
    const helper = await started();
    expect(errorCode(await helper.request("explode", {}))).toBe("BAD_REQUEST");
    expect(errorCode(await helper.request("check", { runId: "x" }))).toBe("BAD_REQUEST");
    expect(await helper.close()).toBe(0);
  });

  test("probes the configured agent and the built-in checks", async () => {
    const helper = await started();
    try {
      const ready = result<{ agent: { available: boolean; reason: string }; checks: { available: boolean } }>(
        await helper.request("probe", { agentConfig: agentConfig("success") }),
      );
      expect(ready.agent.available).toBe(true);
      expect(ready.checks.available).toBe(true);

      const missing = result<{ agent: { available: boolean; reason: string } }>(
        await helper.request("probe", { agentConfig: agentConfig("success", { command: [join(TEMP, "no-such-agent")] }) }),
      );
      expect(missing.agent.available).toBe(false);
      expect(missing.agent.reason).toContain("not installed or executable");
    } finally {
      await helper.close();
    }
  });

  test("checks an inline project with lint and the dynamic engine checks", async () => {
    const helper = await started();
    try {
      const clean = result<{ problems: unknown[] }>(await helper.request("check", { runId: "clean", projectText: PROJECT_TEXT }));
      expect(Array.isArray(clean.problems)).toBe(true);

      const broken = result<{ problems: { code: string; source: string; map?: string }[] }>(
        await helper.request("check", { runId: "broken", projectText: brokenProject() }),
      );
      const missing = broken.problems.filter((problem) => problem.code === "lint/transfer-target-missing");
      expect(missing).toHaveLength(1);
      expect(missing[0]!.source).toBe("check");
      expect(typeof missing[0]!.map).toBe("string");
      const keys = broken.problems.map((problem) => JSON.stringify(problem));
      expect(new Set(keys).size).toBe(keys.length);

      expect(errorCode(await helper.request("check", { runId: "bad", projectText: "{" }))).toBe("BAD_REQUEST");
    } finally {
      await helper.close();
    }
  }, 60_000);

  test("times out and cancels check runs by killing the check process", async () => {
    const helper = await started();
    try {
      expect(errorCode(await helper.request("check", { runId: "slow", projectText: PROJECT_TEXT, timeoutMs: 50 }))).toBe("TIMED_OUT");
      const run = helper.call("check", { runId: "cancel-me", projectText: PROJECT_TEXT });
      await Bun.sleep(100);
      expect(result<{ cancelled: boolean }>(await helper.request("cancel", { runId: "cancel-me" }))).toEqual({ cancelled: true });
      expect(errorCode(await run.response)).toBe("CANCELLED");
      expect(result<{ cancelled: boolean }>(await helper.request("cancel", { runId: "cancel-me" }))).toEqual({ cancelled: false });
    } finally {
      await helper.close();
    }
  }, 30_000);

  test("imports an RPG Maker folder into an empty staging directory and returns a small exact summary", async () => {
    const helper = await started();
    const outputDir = scratch();
    const runId = "import-hollow";
    try {
      const imported = result<ImportResult>(await helper.request("import", {
        runId,
        sourceDir: RPG_MAKER,
        outputDir,
        placeholders: "visible",
      }));
      expect(existsSync(join(outputDir, "project.json"))).toBe(true);
      expect(existsSync(join(outputDir, "coverage.json"))).toBe(true);
      expect(imported.coverage.totals).toEqual({
        Native: 115,
        Degraded: 12,
        Placeholder: 1,
        Dropped: 0,
        total: 128,
      });
      expect(imported.coverage.rows.map((row) => [row.section, row.key, row.counts.Placeholder, row.counts.Dropped])).toEqual([
        ["audio", "se/hollow-chest", 0, 1],
        ["audio", "se/hollow-chime", 0, 1],
        ["audio", "se/hollow-door", 0, 1],
        ["audio", "se/hollow-drip", 0, 1],
        ["audio", "se/hollow-gate", 0, 1],
        ["audio", "se/hollow-steps", 0, 1],
        ["command", "355", 1, 0],
        ["script", "syntax rejected", 1, 0],
      ]);
      expect(imported.warnings.length).toBeLessThanOrEqual(25);
      expect(helper.importEvents(runId)).toEqual([{
        event: "import-progress",
        runId,
        phase: "converting",
        message: "Converting maps, events, art and audio / 正在转换地图、事件、美术和音频",
      }]);
    } finally {
      await helper.close();
    }
  }, 60_000);

  test("imports all non-audio content and Ogg media when ffmpeg is absent from PATH", async () => {
    const helper = await started([process.execPath, HELPER, "serve"], { PATH: "" });
    const outputDir = scratch();
    try {
      const imported = result<ImportResult>(await helper.request("import", {
        runId: "import-without-ffmpeg",
        sourceDir: RPG_MAKER,
        outputDir,
        placeholders: "visible",
      }));
      const project = JSON.parse(readFileSync(join(outputDir, "project.json"), "utf8")) as {
        mapIndex: unknown[];
        audio?: Record<string, string>;
      };
      expect(project.mapIndex).toHaveLength(3);
      expect(Object.keys(project.audio ?? {})).toHaveLength(6);
      expect(readdirSync(join(outputDir, "audio")).sort()).toHaveLength(6);
      const media = JSON.parse(readFileSync(join(outputDir, "audio-media.json"), "utf8")) as Array<{
        status: string;
        reason?: string;
      }>;
      expect(media.filter((record) => record.status === "success")).toHaveLength(6);
      expect(media.filter((record) => record.status === "missing")).toHaveLength(6);
      expect(media.some((record) => record.reason?.includes("audio decoder unavailable"))).toBe(false);
      expect(imported.warnings.some((warning) => warning.includes("audio decoder unavailable"))).toBe(false);
      expect(imported.coverage.rows.filter((row) => row.section === "audio")).toHaveLength(6);
    } finally {
      await helper.close();
    }
  }, 60_000);

  test("refuses a non-empty import staging directory before writing it", async () => {
    const helper = await started();
    const outputDir = scratch();
    const keep = join(outputDir, "keep.txt");
    writeFileSync(keep, "untouched\n");
    try {
      const response = await helper.request("import", {
        runId: "unsafe-output",
        sourceDir: RPG_MAKER,
        outputDir,
        placeholders: "silent",
      });
      expect(errorCode(response)).toBe("BAD_REQUEST");
      expect(readFileSync(keep, "utf8")).toBe("untouched\n");
      expect(readdirSync(outputDir)).toEqual(["keep.txt"]);
    } finally {
      await helper.close();
    }
  });

  test("cancels an active import child", async () => {
    const helper = await started();
    const runId = "cancel-import";
    try {
      const run = helper.call("import", {
        runId,
        sourceDir: RPG_MAKER,
        outputDir: scratch(),
        placeholders: "visible",
      });
      await helper.waitFor((message) => message.event === "import-progress" && message.runId === runId);
      expect(result<{ cancelled: boolean }>(await helper.request("cancel", { runId }))).toEqual({ cancelled: true });
      expect(errorCode(await run.response)).toBe("CANCELLED");
      expect(result<{ cancelled: boolean }>(await helper.request("cancel", { runId }))).toEqual({ cancelled: false });
    } finally {
      await helper.close();
    }
  });

  test("runs the agent and returns the proposal it created", async () => {
    const helper = await started();
    try {
      await expectProposalRun(helper);
    } finally {
      await helper.close();
    }
  }, 30_000);

  test("maps failed and timed-out agent runs to errors", async () => {
    const helper = await started();
    try {
      const failDir = scratch();
      const failed = await helper.request("agent", agentParams(failDir, agentConfig("fail")));
      expect(errorCode(failed)).toBe("FAILED");
      expect(failed.ok ? "" : failed.error.message).toContain("fake agent requested failure");
      expect(existsSync(failDir)).toBe(false);

      const hangDir = scratch();
      expect(errorCode(await helper.request("agent", agentParams(hangDir, agentConfig("hang", { timeoutMs: 300 }))))).toBe("TIMED_OUT");
      expect(existsSync(hangDir)).toBe(false);

      const busyDir = scratch();
      writeFileSync(join(busyDir, "keep.txt"), "not scratch\n");
      expect(errorCode(await helper.request("agent", agentParams(busyDir, agentConfig("success"))))).toBe("BAD_REQUEST");
      expect(existsSync(join(busyDir, "keep.txt"))).toBe(true);
    } finally {
      await helper.close();
    }
  }, 30_000);

  test.skipIf(process.platform === "win32")("cancels a hanging agent and reaps its process group", async () => {
    const helper = await started();
    const files = scratch();
    const pidFile = join(files, "grandchild.pid");
    const workDir = scratch();
    const params = agentParams(workDir, agentConfig("tree", {
      env: { FAKE_AGENT_CHILD_PID_FILE: pidFile, FAKE_AGENT_CHILD_TERM_FILE: join(files, "grandchild.term") },
    }));
    let group = 0;
    try {
      const run = helper.call("agent", params);
      await waitForFile(pidFile);
      const grandchild = Number(readFileSync(pidFile, "utf8"));
      const ps = Bun.spawnSync({ cmd: ["ps", "-o", "pgid=", "-p", String(grandchild)] });
      group = Number(ps.stdout.toString().trim());
      expect(group).toBeGreaterThan(0);
      expect(processGroupExists(group)).toBe(true);
      expect(result<{ cancelled: boolean }>(await helper.request("cancel", { runId: params.runId }))).toEqual({ cancelled: true });
      expect(errorCode(await run.response)).toBe("CANCELLED");
      // The controller SIGKILLs a TERM-resistant group; give the kernel a
      // moment to reap the orphaned grandchild.
      const deadline = Date.now() + 3_000;
      while (processGroupExists(group) && Date.now() < deadline) await Bun.sleep(10);
      expect(processGroupExists(group)).toBe(false);
      expect(helper.events(params.runId).map((event) => event.status)).toContain("cancelling");
      expect(existsSync(workDir)).toBe(false);
    } finally {
      if (group > 0 && processGroupExists(group)) process.kill(-group, "SIGKILL");
      await helper.close();
    }
  }, 30_000);

  test("works as a compiled executable, serving its own MCP subcommand", async () => {
    const binary = join(scratch(), process.platform === "win32" ? "rpgkit-studio-helper.exe" : "rpgkit-studio-helper");
    const build = Bun.spawnSync({ cmd: [process.execPath, "build", "--compile", HELPER, "--outfile", binary], cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode).toBe(0);
    const helper = await started([binary, "serve"]);
    try {
      const ready = result<{ agent: { available: boolean; reason: string } }>(
        await helper.request("probe", { agentConfig: agentConfig("success") }),
      );
      expect(ready.agent).toEqual({ available: true, reason: "offline fake ready" });
      await expectProposalRun(helper);
      const broken = result<{ problems: { code: string }[] }>(
        await helper.request("check", { runId: "compiled", projectText: brokenProject() }),
      );
      expect(broken.problems.some((problem) => problem.code === "lint/transfer-target-missing")).toBe(true);
      const imported = result<ImportResult>(await helper.request("import", {
        runId: "compiled-import",
        sourceDir: RPG_MAKER,
        outputDir: scratch(),
        placeholders: "silent",
      }));
      expect(imported.coverage.totals.total).toBeGreaterThan(0);
    } finally {
      expect(await helper.close()).toBe(0);
    }
  }, 120_000);
});
