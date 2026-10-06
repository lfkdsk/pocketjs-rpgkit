// tools/rpgkit-check/src/registry.ts — the rpgkit-check tools as pure
// descriptors an MCP server can mount. AI1's editing server merges these into
// its own tool list; this module deliberately starts NO server of its own.
//
// Each tool is { name, description, inputSchema, run }: `run` takes the
// parsed args (always including `file`, the project document path) and
// returns a JSON-serializable report. The CLI (cli.ts) is a thin wrapper
// over this registry.

import { lintProject, lintScoped } from "./lint.ts";
import { loadProjectFile } from "./doc.ts";
import { loadShellProject, scopeProjectToMap } from "./shell.ts";
import { lintShellIncremental } from "./incremental.ts";
import { checkLocks, type LockReport } from "./dynamic/locks.ts";
import { checkFreeze, type FreezeReport } from "./dynamic/freeze.ts";
import { checkReach, type ReachReport } from "./dynamic/reach.ts";
import { checkExplore, type ExploreReport } from "./dynamic/explore.ts";
import { renderShots, type ShotOutput, type RenderShotsOptions } from "./shot/render.ts";
import type { CheckReport, Finding } from "./finding.ts";
import type { Dir, Project } from "../../../src/engine/types.ts";
import type { SessionOptions } from "../../../src/engine/session.ts";
import { validateSchema, type Schema, type VError } from "../../../src/engine/schema-validate.ts";
import { CheckArgsError, CheckLoadError } from "./errors.ts";

export { CheckArgsError, CheckLoadError };

export interface CheckTool {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) for the tool's args object. */
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, context?: CheckRunContext): Promise<unknown>;
}

/** Non-JSON execution context. The CLI can load function registries from a
 *  trusted local module; MCP calls intentionally expose only JSON args. */
export interface CheckRunContext {
  sessionOptions?: SessionOptions;
  /** MCP root confinement: a shell's shard files must resolve inside it. */
  root?: string;
  /** Whether the check may persist sidecars (the incremental lint cache).
   *  The MCP proposal-only mode passes false. */
  writable?: boolean;
}

/** Validate `args` against the tool's own inputSchema. Every entry point
 *  (CLI and MCP) goes through this, so a bad arg is a usage error caught
 *  before the check runs. */
export function validateCheckArgs(tool: CheckTool, args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new CheckArgsError("args must be a JSON object", []);
  }
  const errors = validateSchema(tool.inputSchema as Schema, args);
  if (errors.length > 0) {
    throw new CheckArgsError(`${errors[0]!.path}: ${errors[0]!.msg}`, errors);
  }
  return args as Record<string, unknown>;
}

function loadProject(file: unknown, root?: string): { project: Project; schemaErrors: Finding[] } {
  if (typeof file !== "string" || file.length === 0) {
    throw new CheckArgsError("args.file must be a path to an rpgkit-project/v1 JSON document", []);
  }
  const loaded = loadProjectFile(file);
  if (loaded.shell) {
    // A ProjectShell is materialized into the inline view every check
    // consumes. lint's --map/incremental paths load the shell themselves.
    const shell = loadShellProject(file, undefined, root);
    return { project: shell.project, schemaErrors: shell.schemaErrors };
  }
  if (!loaded.project) {
    const findings = loaded.schemaErrors;
    throw new CheckLoadError(
      `rpgkit-check: ${findings[0]?.message ?? "could not load project"}`,
      findings,
    );
  }
  return { project: loaded.project, schemaErrors: loaded.schemaErrors };
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A reach budget arg: a non-negative number, and an integer when the unit
 *  is countable (ticks, states). maxSeconds is a wall-clock valve and may be
 *  fractional. Throws CheckArgsError so every entry point (CLI flags, CLI
 *  --json, MCP) enforces the same value domain. */
function budgetArg(args: Record<string, unknown>, key: string, integer: boolean): number | undefined {
  const v = numArg(args, key);
  if (v === undefined) return undefined;
  if (v < 0 || (integer && !Number.isInteger(v))) {
    throw new CheckArgsError(
      `$.${key}: must be a non-negative${integer ? " integer" : ""} number`,
      [],
    );
  }
  return v;
}

const FILE_PROP = {
  type: "string",
  description: "Path to the rpgkit-project/v1 JSON document to check.",
} as const;

const CHECK_TOOL_DEFS: CheckTool[] = [
  {
    name: "rpgkit-lint",
    description:
      "Static health check of an rpgkit-project/v1 document: switches/variables read but never set " +
      "(or set but never read), dead pages (shadowed or contradictory conditions), missing references " +
      "(transfer/place/common-event/item/audio/sprite/sheet), empty choices, unreachable maps. " +
      "Returns findings with severity, location and a suggestion. Accepts an inline document or a " +
      "ProjectShell (sharded maps are materialized). `map` scopes the pass to one map (only that " +
      "shard is loaded; global checks that need the whole document are skipped). `incremental` caches " +
      "per-shard findings next to a shell and re-checks only changed shards.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PROP,
        map: { type: "string", description: "Scope the pass to one map id; only that shard is loaded." },
        incremental: { type: "boolean", description: "Shell only: reuse cached per-shard findings and re-check only changed shards." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    run: async (args, context) => {
      const file = String(args.file);
      const map = typeof args.map === "string" ? args.map : undefined;
      const loaded = loadProjectFile(file);
      if (loaded.shell) {
        if (map !== undefined) {
          const scoped = loadShellProject(file, map, context?.root);
          return lintScoped(scoped.project, map, scoped.schemaErrors) satisfies CheckReport;
        }
        if (args.incremental === true) {
          return await lintShellIncremental(file, { root: context?.root, writable: context?.writable }) satisfies CheckReport;
        }
        const shell = loadShellProject(file, undefined, context?.root);
        return lintProject(shell.project, shell.schemaErrors) satisfies CheckReport;
      }
      if (!loaded.project) {
        throw new CheckLoadError(
          `rpgkit-check: ${loaded.schemaErrors[0]?.message ?? "could not load project"}`,
          loaded.schemaErrors,
        );
      }
      if (map !== undefined) {
        return lintScoped(scopeProjectToMap(loaded.project, map), map, loaded.schemaErrors) satisfies CheckReport;
      }
      return lintProject(loaded.project, loaded.schemaErrors) satisfies CheckReport;
    },
  },
  {
    name: "rpgkit-locks",
    description:
      "Dynamic permanent-input-lock check: every page containing a lockInput is executed in isolation " +
      "on the real engine; the lock must be released (unlockInput or a map transfer) within the frame " +
      "budget. Returns per-page outcomes and error findings for permanent locks.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PROP,
        frames: { type: "number", description: "Frame budget per lock page (default 12000)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    run: async (args, context) => {
      const { project } = loadProject(args.file, context?.root);
      return checkLocks(project, {
        frames: numArg(args, "frames"),
        sessionOptions: context?.sessionOptions,
      }) satisfies LockReport;
    },
  },
  {
    name: "rpgkit-freeze",
    description:
      "Dynamic freeze scan: enter every map (at a transfer landing or its centre), auto-advance " +
      "dialogs and drive the d-pad for a long window. Flags maps where the input lock holds for the " +
      "whole window, a busy fiber makes no world progress, or the interpreter errors.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PROP,
        windowFrames: { type: "number", description: "Detection window in frames (default 6000)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    run: async (args, context) => {
      const { project } = loadProject(args.file, context?.root);
      return checkFreeze(project, {
        windowFrames: numArg(args, "windowFrames"),
        sessionOptions: context?.sessionOptions,
      }) satisfies FreezeReport;
    },
  },
  {
    name: "rpgkit-reach",
    description:
      "Map reachability by real-engine search with replayable witnesses: breadth-first search over real " +
      "engine states (walk to triggerable events, ride out dialogs/choices/battles/transfers, branch per " +
      "choice option, restore snapshots at branches). Every map reported as reached carries a button-mask " +
      "witness tape the tool replays in a fresh session to verify the arrival; a map reported as notFound " +
      "means the search spent its budgets without finding a witness (a lead, not a proof) and the report " +
      "lists the frontier (which inbound transfers' source pages never ran). Also runs deterministic " +
      "structural checks: transfer target missing, landing on a non-standable tile, orphan maps, and " +
      "dynamic (variable-target) transfers.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PROP,
        start: {
          type: "object",
          description: "Start state (defaults to the project start with a fresh bank).",
          properties: {
            map: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
            dir: { type: "string", enum: ["down", "left", "up", "right"] },
            switches: { type: "object", additionalProperties: { type: "boolean" } },
            variables: { type: "object", additionalProperties: { type: "number" } },
            items: { type: "object", additionalProperties: { type: "number" } },
            gold: { type: "number" },
          },
        },
        maxFrames: { type: "number", description: "Total engine tick budget for the search (default 120000). Non-negative integer; the search may run at most one 6-tick block past it." },
        maxStates: { type: "number", description: "Max states expanded (default 3000). Non-negative integer." },
        maxSeconds: { type: "number", description: "Wall-clock budget in seconds (default 60; a safety valve, not deterministic). Non-negative number." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    run: async (args, context) => {
      const { project } = loadProject(args.file, context?.root);
      const start = args.start as Parameters<typeof checkReach>[1] extends { start?: infer S } ? S : never;
      return checkReach(project, {
        start,
        maxFrames: budgetArg(args, "maxFrames", true),
        maxStates: budgetArg(args, "maxStates", true),
        maxSeconds: budgetArg(args, "maxSeconds", false),
        sessionOptions: context?.sessionOptions,
      }) satisfies ReachReport;
    },
  },
  {
    name: "rpgkit-explore",
    description:
      "Headless exploration coverage: from the project start, walk to every reachable action/playerTouch/" +
      "eventTouch event (BFS on the engine's passage table with live bodies), trigger it (a blocking " +
      "eventTouch page is bumped from a neighbor), auto-advance dialogs " +
      "(choices pick option 0), and follow static transfers to the next map. Returns which event pages " +
      "ran and which never did, with a reason.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PROP,
        frames: { type: "number", description: "Total frame budget (default 6000)." },
        stuckFrames: { type: "number", description: "Frames without progress before giving up (default 600)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    run: async (args, context) => {
      const { project } = loadProject(args.file, context?.root);
      return checkExplore(project, {
        frames: numArg(args, "frames"),
        stuckFrames: numArg(args, "stuckFrames"),
        sessionOptions: context?.sessionOptions,
      }) satisfies ExploreReport;
    },
  },
  {
    name: "rpgkit-shot",
    description:
      "Schematic screenshots: renders a map at a given state as a PNG at two resolutions (PSP 480x272 " +
      "and desktop 960x544) — passable/blocked/void cells from the engine's passage table, event markers " +
      "colored by the active page's trigger, the player, and an optional reachability overlay. Writes " +
      "PNG files and returns their paths and hashes. Requires `bun run build:example` and `bun run build:wasm`.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PROP,
        map: { type: "string", description: "Map id to render." },
        x: { type: "number" },
        y: { type: "number" },
        dir: { type: "string", enum: ["down", "left", "up", "right"] },
        sw: {
          type: "object",
          description: "Switch bank to seed (switches/variables/items/gold).",
          properties: {
            switches: { type: "object", additionalProperties: { type: "boolean" } },
            variables: { type: "object", additionalProperties: { type: "number" } },
            items: { type: "object", additionalProperties: { type: "number" } },
            gold: { type: "number" },
          },
        },
        reach: {
          type: "array",
          items: { type: "string" },
          description: "Optional 'map@x,y' node keys to tint as reachable (from rpgkit-reach).",
        },
        out: { type: "string", description: "Output directory for the PNGs (default: current directory)." },
      },
      required: ["file", "map", "x", "y"],
      additionalProperties: false,
    },
    run: async (args, context) => {
      const { project } = loadProject(args.file, context?.root);
      const options: RenderShotsOptions = {
        map: String(args.map ?? ""),
        x: numArg(args, "x") ?? 0,
        y: numArg(args, "y") ?? 0,
        dir: args.dir as Dir | undefined,
        sw: args.sw as RenderShotsOptions["sw"],
        reach: args.reach as string[] | undefined,
        sessionOptions: context?.sessionOptions,
      };
      const out = typeof args.out === "string" ? args.out : ".";
      const outputs: ShotOutput[] = await renderShots(project, options, out);
      return outputs;
    },
  },
];

/** The mounted tools: every run validates its args against the tool's own
 *  inputSchema first, so a bad arg is a CheckArgsError the entry point
 *  reports, never a crash inside the check. */
export const CHECK_TOOLS: CheckTool[] = CHECK_TOOL_DEFS.map((tool) => ({
  ...tool,
  // async so a CheckArgsError thrown by validation surfaces as a rejected
  // promise (what callers awaiting tool.run expect), not a sync throw.
  run: async (args: Record<string, unknown>, context?: CheckRunContext) =>
    tool.run(validateCheckArgs(tool, args), context),
}));

/** Look up a tool by name (for the CLI). Accepts both the full
 *  "rpgkit-<check>" name and the short "<check>" alias. */
export function checkTool(name: string): CheckTool | undefined {
  return CHECK_TOOLS.find((tool) => tool.name === name) ??
    CHECK_TOOLS.find((tool) => tool.name === `rpgkit-${name}`);
}
