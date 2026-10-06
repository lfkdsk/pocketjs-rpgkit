import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { EDIT_COMMANDS, type EditPatch } from "../editor/api/types.ts";
import { EDIT_TOOLS } from "../editor/api/tools.ts";
import { PROPOSAL_COMMANDS } from "../editor/api/proposals.ts";
import { PROPOSAL_TOOLS } from "../editor/api/proposal-tools.ts";
import { runFileEdit } from "../editor/api/file.ts";
import { runMaterializeCommand } from "../editor/api/materialize.ts";
import type { ProjectShell } from "../src/engine/types.ts";
import {
  MCP_PROTOCOL_VERSION,
  RPGKIT_TOOLS,
  dispatchMcpLine,
  dispatchMcpMessage,
  toolsForAccess,
} from "../tools/rpgkit-edit/mcp.ts";

const ROOT = resolve(import.meta.dir, "..");
const TEMP = join(import.meta.dir, `.rpgkit-edit-mcp-${process.pid}`);
const SUNSTONE = join(ROOT, "examples/sunstone/data/sunstone.json");
const SERVER = join(ROOT, "tools/rpgkit-edit/mcp.ts");

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function copy(): string {
  const path = join(TEMP, `${randomUUID()}.json`);
  copyFileSync(SUNSTONE, path);
  return path;
}

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  return await dispatchMcpMessage({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

const initializeParams = {
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "rpgkit-edit-test", version: "1.0.0" },
};

describe("rpgkit-edit MCP protocol", () => {
  test("initializes, pings, lists tools, and emits nothing for notifications", async () => {
    expect(await dispatchMcpMessage({ jsonrpc: "2.0", id: "init", method: "initialize", params: initializeParams }))
      .toMatchObject({ id: "init", result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } } });
    expect(await dispatchMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await dispatchMcpMessage({ jsonrpc: "2.0", id: 1, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const listed = await dispatchMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any;
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(RPGKIT_TOOLS.map((tool) => tool.name));
    expect(listed.result.tools.every((tool: any) => tool.description.length > 20 && tool.inputSchema.type === "object")).toBe(true);
  });

  test("returns standard JSON-RPC errors for malformed messages, methods and params", async () => {
    expect(await dispatchMcpLine("{bad")).toMatchObject({ error: { code: -32700 } });
    expect(await dispatchMcpMessage([])).toMatchObject({ error: { code: -32600 } });
    expect(await dispatchMcpMessage({ jsonrpc: "2.0", id: 1, method: "missing" })).toMatchObject({ error: { code: -32601 } });
    expect(await dispatchMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "missing", arguments: {} } }))
      .toMatchObject({ error: { code: -32602 } });
    expect(await dispatchMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rpgkit_events_list", arguments: {} } }))
      .toMatchObject({ error: { code: -32602, data: expect.any(Array) } });
    expect(await dispatchMcpMessage({ jsonrpc: "2.0", id: { bad: true }, method: "ping" }))
      .toMatchObject({ id: null, error: { code: -32600 } });
    expect(await dispatchMcpMessage({ jsonrpc: "2.0", id: 4, method: "notifications/initialized" }))
      .toMatchObject({ id: 4, error: { code: -32600 } });
  });

  const cases: { name: string; args: (file: string) => Record<string, unknown> }[] = [
    { name: "rpgkit_project_open", args: (file) => ({ file }) },
    { name: "rpgkit_maps_list", args: (file) => ({ file }) },
    { name: "rpgkit_events_list", args: (file) => ({ file, map: "village" }) },
    { name: "rpgkit_pages_list", args: (file) => ({ file, map: "village", event: "elder" }) },
    { name: "rpgkit_commands_list", args: (file) => ({ file, map: "village", event: "elder", page: 0 }) },
    { name: "rpgkit_tile_paint", args: (file) => ({ file, dryRun: true, map: "village", x: 0, y: 0, tile: "town.1" }) },
    { name: "rpgkit_tile_rect", args: (file) => ({ file, dryRun: true, map: "village", layer: "passage", x: 0, y: 0, width: 10, height: 8, template: "room", doors: [[4, 7]] }) },
    { name: "rpgkit_tile_fill", args: (file) => ({ file, dryRun: true, map: "village", x: 0, y: 0, tile: "town.1" }) },
    { name: "rpgkit_cells_paint", args: (file) => ({ file, dryRun: true, map: "village", layer: "passage", cells: [[4, 4], [5, 4]], value: "block" }) },
    { name: "rpgkit_edges_paint", args: (file) => ({ file, dryRun: true, map: "village", cells: [[2, 2]], brush: { kind: "exit", dir: "left" } }) },
    { name: "rpgkit_map_add", args: (file) => ({ file, dryRun: true, map: "market", width: 4, height: 4, after: "village" }) },
    { name: "rpgkit_map_duplicate", args: (file) => ({ file, dryRun: true, map: "forest" }) },
    { name: "rpgkit_map_delete", args: (file) => ({ file, dryRun: true, map: "cave" }) },
    { name: "rpgkit_map_move", args: (file) => ({ file, dryRun: true, map: "cave", index: 0 }) },
    { name: "rpgkit_event_add", args: (file) => ({ file, dryRun: true, map: "village", event: { id: "mcp-event", x: 9, y: 8, pages: [{ trigger: "action", commands: [] }] } }) },
    { name: "rpgkit_event_update", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", changes: { name: "MCP Elder" } }) },
    { name: "rpgkit_event_delete", args: (file) => ({ file, dryRun: true, map: "village", event: "elder" }) },
    { name: "rpgkit_page_add", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", page: { trigger: "action", commands: [], moveSpeed: 4, moveFrequency: 2, directionFix: true, through: true, facingMode: "scripted" } }) },
    { name: "rpgkit_page_update", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", page: 0, value: { trigger: "action", commands: [], moveSpeed: 6, moveFrequency: 1, directionFix: false, through: false, facingMode: "followMovement" } }) },
    { name: "rpgkit_page_delete", args: (file) => ({ file, dryRun: true, map: "village", event: "village-chest", page: 1 }) },
    { name: "rpgkit_command_insert", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", page: 0, address: { path: [], index: 0 }, command: { op: "text", lines: ["MCP"] } }) },
    { name: "rpgkit_command_delete", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", page: 0, address: { path: [], index: 0 } }) },
    { name: "rpgkit_command_update", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", page: 0, address: { path: [], index: 0 }, field: "cps", value: "30" }) },
    { name: "rpgkit_project_validate", args: (file) => ({ file, map: "village" }) },
    {
      name: "rpgkit_project_save",
      args: (file) => {
        const preview = runFileEdit({ command: "paint-tile", file, dryRun: true, args: { map: "village", x: 0, y: 0, tile: "town.1" } });
        if (!preview.ok) throw new Error(JSON.stringify(preview));
        return { file, dryRun: true, patch: preview.patch as EditPatch };
      },
    },
  ];

  for (const entry of cases) {
    test(`${entry.name} is registered and callable`, async () => {
      const file = copy();
      const before = readFileSync(file, "utf8");
      const args = entry.args(file);
      const response = await call(entry.name, args);
      expect(response).toMatchObject({ jsonrpc: "2.0", id: 7, result: { isError: false } });
      const body = JSON.parse(response.result.content[0].text);
      expect(body.ok).toBe(true);
      if (args.dryRun === true) expect(readFileSync(file, "utf8")).toBe(before);
    });
  }

  test("registry has exactly one MCP tool for every operation", () => {
    expect(new Set(EDIT_TOOLS.map((tool) => tool.name)).size).toBe(EDIT_TOOLS.length);
    expect(EDIT_TOOLS.map((tool) => tool.command).sort()).toEqual([...EDIT_COMMANDS].sort());
    expect(new Set(PROPOSAL_TOOLS.map((tool) => tool.name)).size).toBe(PROPOSAL_TOOLS.length);
    expect(PROPOSAL_TOOLS.map((tool) => tool.command).sort()).toEqual([...PROPOSAL_COMMANDS].sort());
    expect(new Set(RPGKIT_TOOLS.map((tool) => tool.name)).size).toBe(RPGKIT_TOOLS.length);
  });

  test("proposal-only access exposes sidecar proposals but no project or artifact writes", async () => {
    const listed = await dispatchMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      process.cwd(),
      "proposal-only",
    ) as any;
    const names = listed.result.tools.map((tool: any) => tool.name);
    expect(names).toEqual(toolsForAccess("proposal-only").map((tool) => tool.name));
    expect(names).toContain("rpgkit_project_open");
    expect(names).toContain("rpgkit_project_validate");
    expect(names).toContain("rpgkit_proposal_create");
    expect(names).toContain("rpgkit-lint");
    expect(names).not.toContain("rpgkit_tile_paint");
    expect(names).not.toContain("rpgkit_project_save");
    expect(names).not.toContain("rpgkit_proposal_withdraw");
    expect(names).not.toContain("rpgkit-shot");

    const denied = await dispatchMcpMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "rpgkit_tile_paint", arguments: {} },
    }, process.cwd(), "proposal-only");
    expect(denied).toMatchObject({ error: { code: -32601, message: expect.stringContaining("proposal-only") } });
  });

  test("creates, lists, shows and withdraws a proposal through MCP without editing the project", async () => {
    const file = copy();
    const before = readFileSync(file, "utf8");
    const proposal = {
      file,
      id: "mcp-proposal",
      title: "Entrance polish",
      rationale: "Make the path easier to read.",
      author: "mcp-agent",
      createdAt: "2026-09-30T12:00:00.000Z",
      hunks: [{
        id: "entrance",
        summary: "Paint one entrance tile",
        operations: [{ command: "paint-tile", args: { map: "village", x: 0, y: 0, tile: "town.1" } }],
      }],
    };
    expect(await call("rpgkit_proposal_create", proposal))
      .toMatchObject({ result: { isError: false, structuredContent: { ok: true, written: true } } });
    expect(await call("rpgkit_proposals_list", { file }))
      .toMatchObject({ result: { structuredContent: { ok: true, result: [{ id: "mcp-proposal" }] } } });
    expect(await call("rpgkit_proposal_show", { file, id: "mcp-proposal" }))
      .toMatchObject({ result: { structuredContent: { ok: true, result: { proposal: { author: "mcp-agent" } } } } });
    expect(await call("rpgkit_proposal_withdraw", { file, id: "mcp-proposal" }))
      .toMatchObject({ result: { structuredContent: { ok: true, written: true } } });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("a non-dry-run MCP mutation persists and a domain failure is a tool error", async () => {
    const file = copy();
    const changed = await call("rpgkit_tile_paint", { file, map: "village", x: 0, y: 0, tile: "town.1" });
    expect(changed).toMatchObject({ result: { isError: false, structuredContent: { ok: true, written: true } } });
    expect((JSON.parse(readFileSync(file, "utf8")) as any).maps[0].ground[0]).toBe("town.1");

    const failed = await call("rpgkit_tile_paint", { file, map: "missing", x: 0, y: 0, tile: "town.1" });
    expect(failed).toMatchObject({ result: { isError: true, structuredContent: { ok: false, error: { code: "MAP_NOT_FOUND" } } } });
  });

  test("stdio server keeps stdout as one JSON-RPC object per line and survives parse errors", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, SERVER],
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rpgkit_project_open", arguments: { file: SUNSTONE } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rpgkit_events_list", arguments: { file: SUNSTONE, map: "missing" } } }),
      "{bad",
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }),
      "",
    ].join("\n"));
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 3_000);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timeout);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const messages = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3, null, 4, 5]);
    expect(messages[1]).toMatchObject({ result: { isError: false } });
    expect(messages[2]).toMatchObject({ result: { isError: true } });
    expect(messages[3]).toMatchObject({ error: { code: -32700 } });
    expect(messages[4].result.tools).toHaveLength(RPGKIT_TOOLS.length);
  });
});

describe("rpgkit-check tools over MCP", () => {
  test("rpgkit-lint runs on a project copy and returns a clean structured report", async () => {
    const file = copy();
    const response = await call("rpgkit-lint", { file });
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 7, result: { isError: false } });
    const body = JSON.parse(response.result.content[0].text);
    expect(body.check).toBe("lint");
    expect(body.findings.filter((f: any) => f.severity === "error")).toEqual([]);
    // structuredContent is the same object.
    expect(response.result.structuredContent.check).toBe("lint");
  });

  test("rpgkit-reach runs and reports reachable maps", async () => {
    const file = copy();
    const response = await call("rpgkit-reach", { file });
    expect(response).toMatchObject({ result: { isError: false } });
    const body = JSON.parse(response.result.content[0].text);
    expect(body.check).toBe("reach");
    expect(body.reachableMaps).toContain("village");
  }, 30_000);

  test("args failing the inputSchema are a tool error, not a server crash", async () => {
    const file = copy();
    const response = await call("rpgkit-lint", { file, bogus: 1 });
    expect(response).toMatchObject({ result: { isError: true } });
    expect(response.result.content[0].text).toContain("invalid args");
  });

  test("a missing file is a tool-level load error with doc findings", async () => {
    const response = await call("rpgkit-lint", { file: join(TEMP, "does-not-exist.json") });
    expect(response).toMatchObject({ result: { isError: true } });
    expect(response.result.structuredContent.findings[0].check).toBe("doc/unreadable");
  });

  test("a path outside the server root is rejected as invalid params", async () => {
    const response = await call("rpgkit-lint", { file: "/etc/passwd" });
    expect(response).toMatchObject({ error: { code: -32602 } });
  });

  test("rpgkit-shot's array result is wrapped as an object for structuredContent", async () => {
    const file = copy();
    const out = join(TEMP, `shot-${randomUUID()}`);
    const response = await call("rpgkit-shot", { file, map: "village", x: 1, y: 1, out });
    // Without built fixtures the shot is a tool error (preflight), never a
    // -32603 server crash; with fixtures it returns {shots: [...]}.
    if (!response.result.isError) {
      expect(Array.isArray(response.result.structuredContent.shots)).toBe(true);
    }
  });
});

describe("materialize over MCP", () => {
  test("packs an inline project and materializes it back through MCP", async () => {
    const file = copy();
    const packed = join(TEMP, `packed-${randomUUID()}`);
    const pack = await call("rpgkit_project_materialize", { file, direction: "pack", out: packed });
    expect(pack).toMatchObject({ result: { isError: false } });
    const packBody = JSON.parse(pack.result.content[0].text);
    expect(packBody.ok).toBe(true);
    expect(packBody.result.maps).toBeGreaterThan(0);
    const shellFile = join(packed, "project.json");
    const back = join(TEMP, `back-${randomUUID()}.json`);
    const mat = await call("rpgkit_project_materialize", { file: shellFile, direction: "inline", out: back });
    expect(mat).toMatchObject({ result: { isError: false } });
    const matBody = JSON.parse(mat.result.content[0].text);
    expect(matBody.ok).toBe(true);
    // The round trip normalizes key order and map order to canonical (maps
    // sort by id); content is unchanged.
    const before = JSON.parse(readFileSync(file, "utf8"));
    const after = JSON.parse(readFileSync(back, "utf8"));
    const byId = (p: any) => p.maps.sort((m: any, n: any) => (m.id < n.id ? -1 : 1));
    expect(byId(after)).toEqual(byId(before));
  });

  test("a bad direction is a params error, and proposal-only rejects the tool", async () => {
    const file = copy();
    const bad = await call("rpgkit_project_materialize", { file, direction: "sideways" });
    expect(bad).toMatchObject({ error: { code: -32602 } });
    const denied = await dispatchMcpMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "rpgkit_project_materialize", arguments: { file, direction: "pack", out: join(TEMP, "x") } },
    }, process.cwd(), "proposal-only");
    expect(denied).toMatchObject({ error: { code: -32601, message: expect.stringContaining("proposal-only") } });
  });
});

describe("MCP root confinement", () => {
  test("a shell shard symlinking outside the server root is refused, not read", async () => {
    const root = join(TEMP, `shard-root-${randomUUID()}`);
    const outside = join(TEMP, `shard-outside-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    copyFileSync(SUNSTONE, join(root, "sunstone.json"));
    const pack = runMaterializeCommand({ file: join(root, "sunstone.json"), direction: "pack", out: join(root, "packed") });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    const shellFile = join(root, "packed", "project.json");
    const shell = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
    const entry = shell.mapIndex[0]!.entry;
    const shardPath = join(root, "packed", entry);
    // A byte-identical copy outside the root: without confinement the lint
    // would read it through the symlink and report nothing wrong.
    const outsideShard = join(outside, basename(entry));
    copyFileSync(shardPath, outsideShard);
    rmSync(shardPath);
    symlinkSync(outsideShard, shardPath);
    const response = await dispatchMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rpgkit-lint", arguments: { file: shellFile } } },
      root,
      "full",
    ) as any;
    expect(response.result.isError).toBe(false);
    const body = JSON.parse(response.result.content[0].text);
    expect(body.findings.some((f: any) => f.check === "doc/shell" && /outside the project root/.test(f.message))).toBe(true);
    // The outside file was never opened for writing.
    expect(existsSync(outsideShard)).toBe(true);
  });

  test("materialize refuses an output whose ancestor symlinks outside the root", async () => {
    const root = join(TEMP, `out-root-${randomUUID()}`);
    const outside = join(TEMP, `out-outside-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, "escape"));
    copyFileSync(SUNSTONE, join(root, "sunstone.json"));
    const response = await dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "rpgkit_project_materialize",
          arguments: { file: join(root, "sunstone.json"), direction: "pack", out: join(root, "escape", "leak") },
        },
      },
      root,
      "full",
    ) as any;
    expect(response.result.isError).toBe(true);
    const body = JSON.parse(response.result.content[0].text);
    expect(body.error.code).toBe("PATH_OUTSIDE_ROOT");
    expect(existsSync(join(outside, "leak"))).toBe(false);
  });

  test("materialize default pack rejects a sidecar entry that escapes the server root", async () => {
    // The transports sidecar a default pack reads must only carry canonical
    // maps/-relative entries. An entry with ".." segments must fail the
    // default pack (no encoding, no fromShell) before anything is written,
    // inside or outside the root.
    const root = join(TEMP, `sidecar-escape-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const file = join(root, "sunstone.json");
    copyFileSync(SUNSTONE, file);
    writeFileSync(
      `${file}.rpgkit-transports`,
      JSON.stringify({
        version: 1,
        kind: "rpgkit-materialize-transports/1",
        transports: { village: { entry: "../../escaped.rkm", encoding: "compact" } },
      }),
    );
    const out = join(root, "packed");
    const escaped = resolve(out, "../../escaped.rkm");
    rmSync(escaped, { force: true });
    const response = await dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "rpgkit_project_materialize",
          arguments: { file, direction: "pack", out },
        },
      },
      root,
      "full",
    ) as any;
    expect(response.result.isError).toBe(true);
    const body = JSON.parse(response.result.content[0].text);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_DOCUMENT");
    // Nothing was written: no escaped file outside the root, no packed tree.
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(out)).toBe(false);
    rmSync(escaped, { force: true });
  });
});

describe("proposal-only side effects", () => {
  test("incremental lint never writes the cache sidecar", async () => {
    const root = join(TEMP, `prop-only-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    copyFileSync(SUNSTONE, join(root, "sunstone.json"));
    const pack = runMaterializeCommand({ file: join(root, "sunstone.json"), direction: "pack", out: join(root, "packed") });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    const shellFile = join(root, "packed", "project.json");
    const cacheFile = join(root, "packed", ".rpgkit-check-lint.json");
    rmSync(cacheFile, { force: true });

    // Proposal-only mode exposes lint (readOnlyHint) and must not persist
    // the incremental cache next to the project.
    const listed = await dispatchMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rpgkit-lint", arguments: { file: shellFile, incremental: true } } },
      process.cwd(),
      "proposal-only",
    ) as any;
    expect(listed.result.isError).toBe(false);
    expect(existsSync(cacheFile)).toBe(false);

    // Full access does persist the cache.
    const full = await dispatchMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rpgkit-lint", arguments: { file: shellFile, incremental: true } } },
      process.cwd(),
      "full",
    ) as any;
    expect(full.result.isError).toBe(false);
    expect(existsSync(cacheFile)).toBe(true);
  });
});
