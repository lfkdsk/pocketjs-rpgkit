#!/usr/bin/env bun
// Zero-dependency MCP stdio server for the RPG Kit editing operation registry
// and the rpgkit-check QA tools (lint/locks/freeze/reach/explore/shot): one
// server, one tool list, so an agent can edit a project and then check it.

import { createInterface } from "node:readline";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { validateSchema } from "../../src/engine/schema-validate.ts";
import { runFileEdit, type FileEditRequest, confineWithinRoot } from "../../editor/api/file.ts";
import { EDIT_TOOL_BY_NAME, EDIT_TOOLS, type EditToolDefinition } from "../../editor/api/tools.ts";
import { runProposalFileCommand, type ProposalFileRequest } from "../../editor/api/proposals.ts";
import {
  PROPOSAL_TOOL_BY_NAME,
  PROPOSAL_TOOLS,
  type ProposalToolDefinition,
} from "../../editor/api/proposal-tools.ts";
import {
  MATERIALIZE_TOOL_BY_NAME,
  MATERIALIZE_TOOLS,
  type MaterializeToolDefinition,
} from "../../editor/api/materialize-tools.ts";
import { runMaterializeCommand } from "../../editor/api/materialize.ts";
import { CHECK_TOOLS, CheckArgsError, CheckLoadError, type CheckTool } from "../rpgkit-check/src/registry.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_INFO = { name: "pocket-rpgkit-edit", version: "0.1.0" } as const;
export const MCP_USAGE = `Usage:
  bun run rpgkit-edit:mcp [--root <project-directory>] [--proposal-only]

Runs an MCP server over newline-delimited JSON-RPC on stdin/stdout. Tool file
paths must resolve inside --root (default: current working directory). stdout
is reserved for protocol messages. --proposal-only exposes project reads,
non-writing QA checks, and proposal create/list/show; it rejects direct project
mutations, proposal withdrawal, and screenshot output.`;

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

type ToolDefinition = EditToolDefinition | ProposalToolDefinition | MaterializeToolDefinition;
export const RPGKIT_TOOLS: readonly (ToolDefinition | CheckTool)[] = [
  ...EDIT_TOOLS,
  ...PROPOSAL_TOOLS,
  ...MATERIALIZE_TOOLS,
  ...CHECK_TOOLS,
];

export type McpAccess = "full" | "proposal-only";

/** The local-agent editor bridge uses this capability boundary instead of
 * trusting a prompt or optional client-side allowlist. Proposal creation is
 * the only exposed write; it writes a review sidecar, never the project. */
export function toolsForAccess(access: McpAccess): readonly (ToolDefinition | CheckTool)[] {
  if (access === "full") return RPGKIT_TOOLS;
  return [
    ...EDIT_TOOLS.filter((tool) => !tool.mutates),
    ...PROPOSAL_TOOLS.filter((tool) => !tool.destructive),
    ...MATERIALIZE_TOOLS.filter((tool) => !tool.mutates),
    ...CHECK_TOOLS.filter((tool) => tool.name !== "rpgkit-shot"),
  ];
}

function toolAllowed(name: string, access: McpAccess): boolean {
  return toolsForAccess(access).some((tool) => tool.name === name);
}

function publicTool(definition: ToolDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: {
      readOnlyHint: !definition.mutates,
      destructiveHint: definition.kind === "proposal" ? definition.destructive : definition.mutates,
      idempotentHint: !definition.mutates,
      openWorldHint: false,
    },
  };
}

/** A check tool's public descriptor. Only rpgkit-shot writes files (PNGs);
 *  the rest are read-only. */
function publicCheckTool(tool: CheckTool): Record<string, unknown> {
  const writes = tool.name === "rpgkit-shot";
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: !writes,
      destructiveHint: false,
      idempotentHint: !writes,
      openWorldHint: false,
    },
  };
}

const CHECK_TOOL_BY_NAME = new Map<string, CheckTool>(CHECK_TOOLS.map((tool) => [tool.name, tool]));

/** Resolve a tool-supplied path and confirm it stays inside `root`,
 *  symlink-safe: the deepest existing ancestor is realpath'ed, so a symlink
 *  pointing out of the root is caught even when the leaf does not exist yet
 *  (a load error to report, or a fresh shot output dir). */
function confinePath(root: string, p: unknown): { path: string } | { error: string } {
  if (typeof p !== "string" || p.length === 0) return { error: "path must be a non-empty string" };
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    return { error: `server root ${root} does not exist` };
  }
  const confined = confineWithinRoot(rootReal, p);
  if (confined === null) return { error: `path ${p} resolves outside the configured project root` };
  return { path: confined };
}

function toolErrorResult(id: JsonRpcId, message: string, structured?: unknown): JsonRpcResponse {
  return resultResponse(id, {
    content: [{ type: "text", text: message }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    isError: true,
  });
}

/** Run a check tool with root confinement and tool-level errors. A bad path,
 *  bad args or unloadable file is an isError tool result, never a -32603
 *  server crash. `writable` says whether the check may persist sidecars
 *  (the incremental lint cache); proposal-only mode passes false. */
async function callCheckTool(id: JsonRpcId, name: string, args: Record<string, unknown>, root: string, writable: boolean): Promise<JsonRpcResponse> {
  const file = confinePath(root, args.file);
  if ("error" in file) return errorResponse(id, -32602, `Invalid params: ${file.error}`);
  const callArgs: Record<string, unknown> = { ...args, file: file.path };
  if (typeof callArgs.out === "string") {
    const out = confinePath(root, callArgs.out);
    if ("error" in out) return errorResponse(id, -32602, `Invalid params: ${out.error}`);
    callArgs.out = out.path;
  }
  // rpgkit-reach-replay reads a witness file: confine it to the root exactly
  // like file/out (symlink-safe), so a proposal-only server cannot read files
  // outside the configured project root through it.
  if (typeof callArgs.witness === "string") {
    const witness = confinePath(root, callArgs.witness);
    if ("error" in witness) {
      return errorResponse(id, -32602, `Invalid params: ${witness.error}`, { code: "PATH_OUTSIDE_ROOT" });
    }
    callArgs.witness = witness.path;
  }
  const tool = CHECK_TOOL_BY_NAME.get(name)!;
  try {
    const result = await tool.run(callArgs, { root, writable });
    // structuredContent must be an object; rpgkit-shot returns an array.
    const structured = result !== null && typeof result === "object" && !Array.isArray(result)
      ? result
      : { shots: result };
    return resultResponse(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: structured,
      isError: false,
    });
  } catch (error) {
    if (error instanceof CheckArgsError) {
      return toolErrorResult(id, `invalid args: ${error.message}`, { error: error.message, details: error.details });
    }
    if (error instanceof CheckLoadError) {
      return toolErrorResult(id, error.message, { check: name, findings: error.findings });
    }
    return toolErrorResult(id, error instanceof Error ? error.message : String(error));
  }
}

function parseToolRequest(
  params: unknown,
  root: string,
): { definition: ToolDefinition; request: FileEditRequest | ProposalFileRequest } | { error: string; details?: unknown } {
  if (!isRecord(params) || typeof params.name !== "string") {
    return { error: "tools/call params must contain a string name" };
  }
  const definition = EDIT_TOOL_BY_NAME.get(params.name) ?? PROPOSAL_TOOL_BY_NAME.get(params.name);
  if (!definition) return { error: `unknown tool ${JSON.stringify(params.name)}` };
  const input = params.arguments ?? {};
  const errors = validateSchema(definition.inputSchema, input);
  if (errors.length > 0) return { error: `${errors[0]!.path}: ${errors[0]!.msg}`, details: errors };
  const values = input as Record<string, unknown>;
  const { file, dryRun, ...args } = values;
  return {
    definition,
    request: {
      command: definition.command as never,
      file: file as string,
      args,
      dryRun: dryRun === true,
      root,
    },
  };
}

/** Pure single-message dispatcher. Notifications return null and emit no
 * protocol response. Edit calls are synchronous and serialized by the line
 * reader; check calls are async (they drive the engine) and awaited. */
export async function dispatchMcpMessage(
  value: unknown,
  root = process.cwd(),
  access: McpAccess = "full",
): Promise<JsonRpcResponse | null> {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return errorResponse(null, -32600, "Invalid Request: expected a JSON-RPC 2.0 object with method");
  }
  if (Object.prototype.hasOwnProperty.call(value, "id") && value.id !== null && typeof value.id !== "string" && typeof value.id !== "number") {
    return errorResponse(null, -32600, "Invalid Request: id must be a string, number, or null");
  }
  const request = value as unknown as JsonRpcRequest;
  const notification = !Object.prototype.hasOwnProperty.call(value, "id");
  const id = request.id ?? null;

  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") {
    return notification ? null : errorResponse(id, -32600, `${request.method} must be a notification without id`);
  }
  if (notification) return null;

  if (request.method === "initialize") {
    if (!isRecord(request.params) || typeof request.params.protocolVersion !== "string" ||
      !isRecord(request.params.capabilities) || !isRecord(request.params.clientInfo) ||
      typeof request.params.clientInfo.name !== "string" || typeof request.params.clientInfo.version !== "string") {
      return errorResponse(id, -32602, "Invalid params: initialize requires protocolVersion, capabilities, and clientInfo{name,version}");
    }
    return resultResponse(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: MCP_SERVER_INFO,
      instructions: access === "proposal-only"
        ? "Inspect and check the project, then create a review proposal. Direct project writes are disabled."
        : "Use list tools before editing. Mutations save atomically unless dryRun is true; keep the returned patch to undo with rpgkit_project_save direction=reverse.",
    });
  }
  if (request.method === "ping") return resultResponse(id, {});
  if (request.method === "tools/list") {
    if (request.params !== undefined && !isRecord(request.params)) return errorResponse(id, -32602, "Invalid params: tools/list params must be an object");
    return resultResponse(id, {
      tools: toolsForAccess(access).map((tool) =>
        "kind" in tool ? publicTool(tool) : publicCheckTool(tool)),
    });
  }
  if (request.method === "tools/call") {
    if (!isRecord(request.params) || typeof request.params.name !== "string") {
      return errorResponse(id, -32602, "Invalid params: tools/call params must contain a string name");
    }
    const toolName = request.params.name;
    if (access !== "full" && !toolAllowed(toolName, access)) {
      return errorResponse(id, -32601, `Tool not available in ${access} mode: ${toolName}`);
    }
    if (CHECK_TOOL_BY_NAME.has(toolName)) {
      const args = isRecord(request.params.arguments) ? request.params.arguments : {};
      return callCheckTool(id, toolName, args, root, access === "full");
    }
    if (MATERIALIZE_TOOL_BY_NAME.has(toolName)) {
      const args = isRecord(request.params.arguments) ? request.params.arguments : {};
      const definition = MATERIALIZE_TOOL_BY_NAME.get(toolName)!;
      const errors = validateSchema(definition.inputSchema, args);
      if (errors.length > 0) {
        return errorResponse(id, -32602, `Invalid params: ${errors[0]!.path}: ${errors[0]!.msg}`, errors);
      }
      const values = args as Record<string, unknown>;
      if (typeof values.file !== "string" || values.file.length === 0) {
        return errorResponse(id, -32602, "Invalid params: file must be a non-empty string");
      }
      const { file, dryRun, ...rest } = values;
      const response = runMaterializeCommand({
        file,
        direction: rest.direction as "inline" | "pack",
        ...(typeof rest.map === "string" ? { map: rest.map } : {}),
        ...(typeof rest.out === "string" ? { out: rest.out } : {}),
        ...(rest.encoding !== undefined ? { encoding: rest.encoding as "json" | "compact" | "auto" } : {}),
        ...(typeof rest.fromShell === "string" ? { fromShell: rest.fromShell } : {}),
        dryRun: dryRun === true,
        root,
      });
      const text = JSON.stringify(response);
      return resultResponse(id, {
        content: [{ type: "text", text }],
        structuredContent: response,
        isError: !response.ok,
      });
    }
    const parsed = parseToolRequest(request.params, root);
    if ("error" in parsed) return errorResponse(id, -32602, `Invalid params: ${parsed.error}`, parsed.details);
    try {
      const response = parsed.definition.kind === "proposal"
        ? runProposalFileCommand(parsed.request as ProposalFileRequest)
        : runFileEdit(parsed.request as FileEditRequest);
      const text = JSON.stringify(response);
      return resultResponse(id, {
        content: [{ type: "text", text }],
        structuredContent: response,
        isError: !response.ok,
      });
    } catch (error) {
      return errorResponse(id, -32603, "Internal error", error instanceof Error ? error.message : String(error));
    }
  }
  return errorResponse(id, -32601, `Method not found: ${request.method}`);
}

export async function dispatchMcpLine(
  line: string,
  root = process.cwd(),
  access: McpAccess = "full",
): Promise<JsonRpcResponse | null> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return errorResponse(null, -32700, "Parse error", error instanceof Error ? error.message : String(error));
  }
  return await dispatchMcpMessage(value, root, access);
}

async function writeResponse(response: JsonRpcResponse): Promise<boolean> {
  try {
    if (!process.stdout.write(`${JSON.stringify(response)}\n`)) await once(process.stdout, "drain");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") return false;
    throw error;
  }
}

export async function runMcpServer(root = process.cwd(), access: McpAccess = "full"): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const response = line.length > 4 * 1024 * 1024
      ? errorResponse(null, -32600, "Invalid Request: message exceeds 4 MiB")
      : await dispatchMcpLine(line, root, access);
    if (response && !(await writeResponse(response))) break;
  }
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${MCP_USAGE}\n`);
  } else {
    const argv = process.argv.slice(2);
    let root = process.cwd();
    let access: McpAccess = "full";
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index]!;
      if (argument === "--root") {
        const value = argv[++index];
        if (!value) throw new Error("--root requires a directory");
        root = value;
      } else if (argument.startsWith("--root=")) {
        root = argument.slice("--root=".length);
      } else if (argument === "--proposal-only") {
        access = "proposal-only";
      } else {
        throw new Error(`unknown option ${argument}`);
      }
    }
    await runMcpServer(root, access);
  }
}
