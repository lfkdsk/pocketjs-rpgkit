#!/usr/bin/env bun
// JSON-only CLI for the headless RPG Kit editing API.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EDIT_COMMANDS } from "../../editor/api/types.ts";
import { runFileEdit } from "../../editor/api/file.ts";
import { PROPOSAL_COMMANDS, runProposalFileCommand } from "../../editor/api/proposals.ts";
import { runMaterializeCommand } from "../../editor/api/materialize.ts";

export interface CliOptions {
  command: string;
  file: string;
  args: unknown;
  dryRun: boolean;
}

export const CLI_USAGE = `Usage:
  bun tools/rpgkit-edit/cli.ts <command> --file <project.json> [--json '<args>'] [--map <id>] [--dry-run]

Commands:
  ${[...EDIT_COMMANDS, ...PROPOSAL_COMMANDS].join("\n  ")}
  materialize            convert between an inline document and a sharded
                         ProjectShell (--json '{"direction":"inline|pack",...}')

--json accepts an inline JSON object or @path/to/args.json. Relative @paths
resolve next to --file. A "file" key inside --json is ignored: the explicit
--file argument is always the input.
--map scopes validate to one map (and one shard for a ProjectShell).
Edit mutations save atomically by default and return a reversible patch.
Proposal commands operate on the adjacent proposal queue. --dry-run validates
and returns the result without writing the project or sidecar.`;

function optionValue(argv: readonly string[], index: number, name: string): { value: string; consumed: number } {
  const argument = argv[index]!;
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, consumed: 1 };
}

export function parseCliArgs(argv: readonly string[]): CliOptions | { help: true } {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };
  const command = argv[0]!;
  let file = "";
  let json = "{}";
  let map: string | undefined;
  let dryRun = false;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--file" || argument.startsWith("--file=")) {
      const parsed = optionValue(argv, index, "--file");
      file = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (argument === "--json" || argument.startsWith("--json=")) {
      const parsed = optionValue(argv, index, "--json");
      json = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (argument === "--map" || argument.startsWith("--map=")) {
      const parsed = optionValue(argv, index, "--map");
      map = parsed.value;
      index += parsed.consumed;
      continue;
    }
    throw new Error(`unknown option ${argument}`);
  }
  if (!file) throw new Error("--file is required");
  const encoded = json.startsWith("@")
    ? readFileSync(resolve(dirname(resolve(file)), json.slice(1)), "utf8")
    : json;
  let args: unknown;
  try {
    args = JSON.parse(encoded);
  } catch (error) {
    throw new Error(`--json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (map !== undefined) {
    if (command !== "validate") throw new Error("--map is only supported by validate");
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new Error("--json must be an object when --map is present");
    }
    args = { ...args as Record<string, unknown>, map };
  }
  return { command, file, args, dryRun };
}

export function runCli(argv: readonly string[]): number {
  try {
    const options = parseCliArgs(argv);
    if ("help" in options) {
      process.stdout.write(`${CLI_USAGE}\n`);
      return 0;
    }
    const response = (PROPOSAL_COMMANDS as readonly string[]).includes(options.command)
      ? runProposalFileCommand({
          command: options.command as (typeof PROPOSAL_COMMANDS)[number],
          file: options.file,
          args: options.args,
          dryRun: options.dryRun,
        })
      : options.command === "materialize"
        ? runMaterializeCommand({
            ...(typeof options.args === "object" && options.args !== null
              ? (() => {
                  // The explicit --file wins; a "file" key in the operation
                  // JSON must not become a second, higher-priority input.
                  const { file: _jsonFile, ...rest } = options.args as Record<string, unknown>;
                  return rest;
                })()
              : {}),
            file: options.file,
            dryRun: options.dryRun,
          } as Parameters<typeof runMaterializeCommand>[0])
        : runFileEdit(options);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return response.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: {
        code: "CLI_USAGE",
        message: error instanceof Error ? error.message : String(error),
        expected: CLI_USAGE,
      },
    })}\n`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = runCli(process.argv.slice(2));
