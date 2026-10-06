// editor/api/materialize-tools.ts — MCP tool descriptor for the materialize
// command (inline <-> sharded ProjectShell conversion).

import type { MaterializeRequest } from "./materialize.ts";

export interface MaterializeToolDefinition {
  kind: "materialize";
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Writes files (a full materialize or any pack direction requires out). */
  mutates: boolean;
}

const fileProp = {
  type: "string",
  description:
    "Path to the project file: a ProjectShell for direction \"inline\", an inline " +
    "rpgkit-project/v1 document for direction \"pack\".",
} as const;

export const MATERIALIZE_TOOLS: readonly MaterializeToolDefinition[] = [
  {
    kind: "materialize",
    name: "rpgkit_project_materialize",
    title: "Materialize or pack a project",
    description:
      "Convert between an inline rpgkit-project/v1 document and a sharded ProjectShell. " +
      "direction \"inline\" expands a shell plus its map shards into one inline JSON document " +
      "(with `map`, writes just that map's MapDef) and records the shell's per-map transports " +
      "in a sidecar next to the output; direction \"pack\" splits an inline document " +
      "into a shell plus per-map shard files under `out` (compact rpgkit-map/1 when smaller). " +
      "Both directions are deterministic: pack after materialize reproduces a splitProjectMaps " +
      "shell byte-for-byte — a default pack reads the recorded transports, so a mixed-transport " +
      "shell round-trips with no flags; give `fromShell` to name the shell explicitly or " +
      "`encoding` to re-decide every map. `out` is a file for inline (required unless `map` is given) and a " +
      "directory for pack (required; an existing project.json there is refused).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["file", "direction"],
      properties: {
        file: fileProp,
        direction: { type: "string", enum: ["inline", "pack"], description: "inline: shell+shards to one document; pack: document to shell+shards." },
        map: { type: "string", description: "inline direction: materialize just this map id." },
        out: { type: "string", description: "Output file (inline) or directory (pack)." },
        encoding: { type: "string", enum: ["json", "compact", "auto"], description: "pack direction shard encoding (default auto)." },
        fromShell: { type: "string", description: "pack direction: preserve each map's transport (JSON/compact) and entry path from this shell, so a mixed-transport shell round-trips byte-for-byte." },
        dryRun: { type: "boolean", description: "Validate and report without writing." },
      },
    },
    mutates: true,
  },
];

export const MATERIALIZE_TOOL_BY_NAME: ReadonlyMap<string, MaterializeToolDefinition> = new Map(
  MATERIALIZE_TOOLS.map((tool) => [tool.name, tool]),
);

export type { MaterializeRequest };
