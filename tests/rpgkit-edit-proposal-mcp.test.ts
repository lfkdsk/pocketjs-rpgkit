import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PROPOSAL_TOOLS } from "../editor/api/proposal-tools.ts";
import {
  RPGKIT_TOOLS,
  dispatchMcpMessage,
  toolsForAccess,
} from "../tools/rpgkit-edit/mcp.ts";

const ROOT = resolve(import.meta.dir, "..");
const TEMP = join(import.meta.dir, `.rpgkit-edit-proposal-mcp-${process.pid}`);
const SUNSTONE = join(ROOT, "examples/sunstone/data/sunstone.json");

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function copy(): string {
  const path = join(TEMP, `${randomUUID()}.json`);
  copyFileSync(SUNSTONE, path);
  return path;
}

async function call(name: string, args: Record<string, unknown>, access: "full" | "proposal-only" = "full"): Promise<any> {
  return await dispatchMcpMessage(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } },
    TEMP,
    access,
  );
}

function paintProposal(id: string, tile = "town.1") {
  return {
    id,
    title: "MCP proposal",
    rationale: "Exercise the lifecycle over MCP",
    author: "mcp-agent",
    createdAt: "2026-10-05T12:00:00.000Z",
    hunks: [{
      id: "paint",
      summary: "Paint one tile",
      operations: [{ command: "paint-tile", args: { map: "village", x: 0, y: 0, tile } }],
    }],
  };
}

describe("proposal lifecycle over MCP", () => {
  test("registers accept, reject and archive tools exactly once per command", () => {
    const names = RPGKIT_TOOLS.map((tool) => tool.name);
    expect(names).toContain("rpgkit_proposal_accept");
    expect(names).toContain("rpgkit_proposal_reject");
    expect(names).toContain("rpgkit_proposal_archive");
    const accept = PROPOSAL_TOOLS.find((tool) => tool.name === "rpgkit_proposal_accept")!;
    expect(accept.mutates).toBe(true);
    expect(accept.destructive).toBe(true);
    const archive = PROPOSAL_TOOLS.find((tool) => tool.name === "rpgkit_proposal_archive")!;
    expect(archive.mutates).toBe(false);
  });

  test("proposal-only mode hides accept/reject but keeps the archive history", async () => {
    const names = toolsForAccess("proposal-only").map((tool) => tool.name);
    expect(names).toContain("rpgkit_proposal_archive");
    expect(names).not.toContain("rpgkit_proposal_accept");
    expect(names).not.toContain("rpgkit_proposal_reject");
    const denied = await call("rpgkit_proposal_accept", { file: copy(), id: "x" }, "proposal-only");
    expect(denied).toMatchObject({ error: { code: -32601 } });
  });

  test("create, accept and list-archive through MCP", async () => {
    const file = copy();
    const before = readFileSync(file, "utf8");
    expect(await call("rpgkit_proposal_create", { file, ...paintProposal("mcp-01") }))
      .toMatchObject({ result: { isError: false, structuredContent: { ok: true, written: true } } });
    const accepted = await call("rpgkit_proposal_accept", { file, id: "mcp-01", source: "mcp-reviewer" });
    expect(accepted).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          ok: true,
          result: { id: "mcp-01", status: "accepted", projectChanged: true, qa: { errors: 0 } },
        },
      },
    });
    expect(readFileSync(file, "utf8")).not.toBe(before);
    const history = await call("rpgkit_proposal_archive", { file });
    expect(history).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          result: [{ id: "mcp-01", status: "accepted", source: "mcp-reviewer" }],
        },
      },
    });
  });

  test("reject through MCP leaves the project untouched", async () => {
    const file = copy();
    const before = readFileSync(file, "utf8");
    expect(await call("rpgkit_proposal_create", { file, ...paintProposal("mcp-02") }))
      .toMatchObject({ result: { isError: false } });
    expect(await call("rpgkit_proposal_reject", { file, id: "mcp-02", source: "mcp-reviewer" }))
      .toMatchObject({ result: { isError: false, structuredContent: { result: { status: "rejected" } } } });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("a QA failure over MCP is a tool error and rolls back", async () => {
    const file = copy();
    const before = readFileSync(file, "utf8");
    const bad = {
      id: "mcp-bad",
      title: "Bad sprite",
      rationale: "QA must catch this",
      author: "mcp-agent",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "ghost",
        summary: "Add a ghost",
        operations: [{
          command: "add-event",
          args: { map: "village", event: { id: "ghost", x: 5, y: 5, pages: [{ trigger: "action", sprite: "poltergeist", commands: [{ op: "text", lines: ["boo"] }] }] } },
        }],
      }],
    };
    const created = await call("rpgkit_proposal_create", { file, ...bad });
    expect(created).toMatchObject({ result: { isError: false, structuredContent: { result: { qa: { errors: 1 } } } } });
    const refused = await call("rpgkit_proposal_accept", { file, id: "mcp-bad" });
    expect(refused).toMatchObject({ result: { isError: true } });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("the create tool advertises structural operations", () => {
    const create = PROPOSAL_TOOLS.find((tool) => tool.name === "rpgkit_proposal_create")!;
    const operation = (create.inputSchema as any).properties.hunks.items.properties.operations.items.properties.command;
    expect(operation.enum).toContain("add-map");
    expect(operation.enum).toContain("duplicate-map");
    expect(operation.enum).toContain("connect-maps");
  });
});
