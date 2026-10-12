// studio-desktop/src/helper-protocol.ts — the JSON-lines protocol between
// the Electron main process and the Bun helper (studio-desktop/src/helper.ts).
// Types only, plus one tolerant line parser: the main process bundles this
// for Node, so nothing here may touch Bun or the file system.
//
//   main -> helper   {"hello": "<token>"} first, then HelperRequest lines
//   helper -> main   {"hello": "ok", "version": 2}, then HelperResponse and
//                    HelperEvent lines (events carry no id)

import type { StudioProblem } from "../../editor/studio/problems.ts";
import type { LocalAgentEditorContext, LocalAgentRunStatus } from "../../editor/agent/types.ts";
import type { RpgMakerImportCoverage } from "../../editor/studio/host.ts";

export const HELPER_PROTOCOL_VERSION = 2;

/** Environment variable carrying the per-launch hello token. */
export const HELPER_TOKEN_ENV = "RPGKIT_HELPER_TOKEN";

/** Exit code when the hello token is missing or wrong. */
export const HELPER_EXIT_BAD_TOKEN = 2;

export interface HelperHello {
  hello: string;
}

export interface HelperHelloReply {
  hello: "ok";
  version: typeof HELPER_PROTOCOL_VERSION;
}

export interface ProbeParams {
  /** Absolute path of an agent config JSON; absent = the default adapter. */
  agentConfig?: string;
}

export interface Availability {
  available: boolean;
  reason: string;
}

export interface ProbeResult {
  agent: Availability;
  checks: Availability;
}

export interface CheckParams {
  runId: string;
  /** Inline rpgkit-project/v1 document text. */
  projectText: string;
  /** Wall-clock limit for the whole check run (default 60000). */
  timeoutMs?: number;
}

export interface CheckResult {
  problems: StudioProblem[];
}

export interface AgentParams {
  runId: string;
  prompt: string;
  projectText: string;
  context: LocalAgentEditorContext;
  agentConfig?: string;
  /** Empty per-run scratch directory; the helper removes it when the run ends. */
  workDir: string;
}

export interface AgentResult {
  /** JSON texts of the new pending EditProposal values this run created. */
  proposals: string[];
}

export type ImportPlaceholders = "visible" | "silent";

export interface ImportParams {
  runId: string;
  /** Absolute RPG Maker MV/MZ project directory selected by the user. */
  sourceDir: string;
  /** Absolute, existing and empty staging directory owned by the main process. */
  outputDir: string;
  placeholders: ImportPlaceholders;
}

/** Deliberately small: the complete reports remain in coverage.json/.md. */
export interface ImportResult {
  /** Command headline totals plus every Placeholder/Dropped row. */
  coverage: RpgMakerImportCoverage;
  warnings: string[];
}

export interface CancelParams {
  runId: string;
}

export interface CancelResult {
  cancelled: boolean;
}

export interface HelperMethods {
  probe: { params: ProbeParams; result: ProbeResult };
  check: { params: CheckParams; result: CheckResult };
  import: { params: ImportParams; result: ImportResult };
  agent: { params: AgentParams; result: AgentResult };
  cancel: { params: CancelParams; result: CancelResult };
}

export type HelperMethod = keyof HelperMethods;

export type HelperRequest = {
  [M in HelperMethod]: { id: number; method: M; params: HelperMethods[M]["params"] };
}[HelperMethod];

export type HelperErrorCode =
  | "BAD_REQUEST"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "UNAVAILABLE";

export interface HelperError {
  code: HelperErrorCode;
  message: string;
}

export type HelperResponse<R = unknown> =
  | { id: number; ok: true; result: R }
  | { id: number; ok: false; error: HelperError };

export interface AgentStateEvent {
  event: "agent-state";
  runId: string;
  status: LocalAgentRunStatus;
  message: string;
}

export interface ImportProgressEvent {
  event: "import-progress";
  runId: string;
  phase: "converting";
  message: string;
}

export type HelperEvent = AgentStateEvent | ImportProgressEvent;

/** Anything the helper may write after its hello reply. */
export type HelperOutput = HelperHelloReply | HelperResponse | HelperEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse one protocol line. Blank lines, non-JSON and non-object values
 * return null so a stray diagnostic can never crash either side. */
export function parseHelperLine(line: string): Record<string, unknown> | null {
  const text = line.trim();
  if (text === "" || text[0] !== "{") return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
