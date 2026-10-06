// MCP-visible proposal lifecycle tools. Kept separate from EDIT_TOOLS because
// these mutate proposal sidecars, never the project document itself.

import { PROPOSAL_COMMANDS, type ProposalCommandName } from "./proposals.ts";

export interface ProposalToolDefinition {
  kind: "proposal";
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  command: ProposalCommandName;
  mutates: boolean;
  destructive: boolean;
}

const file = {
  type: "string",
  minLength: 1,
  description: "Target rpgkit-project/v1 JSON document. Its queue is stored beside it in <file>.proposals/.",
};
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" };
const dryRun = { type: "boolean", default: false };
const operation = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: {
      enum: [
        "add-item", "add-sprite", "add-asset",
        "update-map", "move-map", "add-map", "duplicate-map", "delete-map",
        "paint-tile", "paint-rect", "fill-region", "paint-passage",
        "add-event", "update-event", "delete-event", "add-page", "update-page",
        "delete-page", "insert-command", "delete-command", "update-command",
        "connect-maps", "batch",
      ],
    },
    args: { type: "object" },
  },
};

function proposalTool(
  name: string,
  title: string,
  command: ProposalCommandName,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  mutates: boolean,
  destructive = false,
): ProposalToolDefinition {
  return {
    kind: "proposal",
    name,
    title,
    command,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["file", ...required],
      properties: { file, ...properties, ...(mutates ? { dryRun } : {}) },
    },
    mutates,
    destructive,
  };
}

export const PROPOSAL_TOOLS: readonly ProposalToolDefinition[] = [
  proposalTool(
    "rpgkit_proposal_create",
    "Create edit proposal",
    "propose",
    "Dry-run typed edit operations into independently reviewable hunks, validate their combined result, and write one proposal sidecar without changing the project.",
    {
      id,
      title: { type: "string", minLength: 1, maxLength: 160 },
      rationale: { type: "string", minLength: 1, maxLength: 4000 },
      author: { type: "string", minLength: 1, maxLength: 160 },
      createdAt: { type: "string" },
      hunks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "summary", "operations"],
          properties: {
            id,
            summary: { type: "string", minLength: 1, maxLength: 240 },
            operations: { type: "array", minItems: 1, items: operation },
          },
        },
      },
    },
    ["id", "title", "rationale", "author", "hunks"],
    true,
  ),
  proposalTool(
    "rpgkit_proposals_list",
    "List pending edit proposals",
    "list-proposals",
    "List pending proposals with author, hunk counts and live per-hunk conflict assessment against the current project.",
    {},
    [],
    false,
  ),
  proposalTool(
    "rpgkit_proposal_show",
    "Show edit proposal",
    "show-proposal",
    "Read a pending or archived proposal, including hunk decisions and live conflict assessment against the current project.",
    { id },
    ["id"],
    false,
  ),
  proposalTool(
    "rpgkit_proposal_withdraw",
    "Withdraw edit proposal",
    "withdraw-proposal",
    "Remove a pending proposal without changing the target project. Use dryRun to verify the target without removing it.",
    { id },
    ["id"],
    true,
    true,
  ),
  proposalTool(
    "rpgkit_proposal_accept",
    "Accept edit proposal",
    "accept-proposal",
    "Apply every clean hunk of a pending proposal as one transaction, re-run the proposal QA gate (schema, references, reachability), then archive the proposal with its decision. A conflict or QA error rolls the whole acceptance back: the project and the proposal queue stay untouched.",
    {
      id,
      source: { type: "string", minLength: 1, maxLength: 160, description: "Who accepts; recorded on the archived decision. Defaults to cli." },
    },
    ["id"],
    true,
    true,
  ),
  proposalTool(
    "rpgkit_proposal_reject",
    "Reject edit proposal",
    "reject-proposal",
    "Record a rejection decision on every hunk of a pending proposal and archive it without changing the target project.",
    {
      id,
      source: { type: "string", minLength: 1, maxLength: 160, description: "Who rejects; recorded on the archived decision. Defaults to cli." },
    },
    ["id"],
    true,
    true,
  ),
  proposalTool(
    "rpgkit_proposal_archive",
    "List archived proposals",
    "list-archive",
    "List decided proposals with their decision time, deciding source, and a diff summary (hunk count, change count, touched paths).",
    {},
    [],
    false,
  ),
] as const;

if (PROPOSAL_TOOLS.map((tool) => tool.command).sort().join("\n") !== [...PROPOSAL_COMMANDS].sort().join("\n")) {
  throw new Error("proposal MCP registry must contain exactly one tool per proposal command");
}

export const PROPOSAL_TOOL_BY_NAME: ReadonlyMap<string, ProposalToolDefinition> = new Map(
  PROPOSAL_TOOLS.map((definition) => [definition.name, definition]),
);
