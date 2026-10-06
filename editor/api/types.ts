// editor/api/types.ts — stable JSON wire types for headless project editing.

import type {
  JsonValue,
  MapDef,
  ProjectShell,
} from "../../src/engine/types.ts";

export const EDIT_COMMANDS = [
  "open",
  "list-maps",
  "list-events",
  "list-pages",
  "list-commands",
  "list-items",
  "get-item",
  "add-item",
  "update-item",
  "remove-item",
  "list-sprites",
  "get-sprite",
  "add-sprite",
  "update-sprite",
  "remove-sprite",
  "list-audio",
  "get-audio",
  "add-audio",
  "update-audio",
  "remove-audio",
  "list-sheets",
  "get-sheet",
  "add-sheet",
  "update-sheet",
  "remove-sheet",
  "list-switches",
  "get-switch",
  "add-switch",
  "update-switch",
  "remove-switch",
  "list-variables",
  "get-variable",
  "add-variable",
  "update-variable",
  "remove-variable",
  "update-map",
  "add-map",
  "duplicate-map",
  "delete-map",
  "move-map",
  "paint-tile",
  "paint-rect",
  "fill-region",
  "paint-passage",
  "paint-cells",
  "paint-edges",
  "add-event",
  "update-event",
  "delete-event",
  "add-page",
  "update-page",
  "delete-page",
  "insert-command",
  "delete-command",
  "update-command",
  "validate",
  "save",
] as const;

export type EditCommandName = (typeof EDIT_COMMANDS)[number];

/** One side of a patch change. `exists` distinguishes a missing property
 * from a property whose JSON value is null. */
export type PatchValue =
  | { exists: false }
  | { exists: true; value: JsonValue };

/** A reversible JSON change. Paths use RFC 6901 JSON Pointer spelling. */
export interface EditChange {
  path: string;
  before: PatchValue;
  after: PatchValue;
}

/** Semantic hashes make a patch fail closed when the document has drifted.
 * Each change contains both values, so the same patch applies forward or in
 * reverse without a separate undo payload. */
export interface EditPatch {
  format: "rpgkit-edit/patch-v1";
  beforeHash: string;
  afterHash: string;
  changes: EditChange[];
}

/** The semantic document patched when a ProjectShell is edited. Shard keys
 * are the stable mapIndex `entry` strings, not map ids (an id can itself be
 * changed by a patch). Only shards involved in an operation are present. */
export interface ShardedEditDocument {
  kind: "rpgkit-edit/sharded-document-v1";
  shell: ProjectShell;
  shards: Record<string, MapDef>;
}

/** Multi-file output produced by a successful ProjectShell mutation. The
 * map only contains byte-changed shard entries. The file adapter stages all
 * outputs, publishes the shell commit marker last, and attempts rollback on
 * failure; the filesystem operation is not crash-atomic across files. */
export interface ShardedEditOutput {
  shell: string;
  shards: Record<string, string>;
}

export interface ShardedEditExecution {
  response: EditResponse;
  output?: ShardedEditOutput;
}

export interface ProjectSummary {
  format: string;
  title: string;
  documentKind: "inline" | "shell";
  editable: boolean;
  mapCount: number;
  /** SHA-256 of canonical semantic JSON. Positional page/command addresses
   * are reusable while this revision still matches. */
  revision: string;
}

export interface EditErrorBody {
  code: string;
  message: string;
  path?: string;
  expected?: unknown;
  actual?: unknown;
  details?: unknown;
}

export interface EditSuccess {
  ok: true;
  command: EditCommandName;
  project: ProjectSummary;
  changed: boolean;
  addresses: string[];
  diff: EditChange[];
  patch?: EditPatch;
  result: unknown;
}

export interface EditFailure {
  ok: false;
  command?: string;
  error: EditErrorBody;
}

export type EditResponse = EditSuccess | EditFailure;

export interface EditExecution {
  response: EditResponse;
  /** Present for a successful modifying operation. The file adapter decides
   * whether to persist it (normal mode) or discard it (dry-run). */
  output?: string;
}

export interface FileEditSuccess extends EditSuccess {
  file: string;
  dryRun: boolean;
  written: boolean;
  /** Real paths replaced by a successful sharded write, in commit order.
   * Absent for inline documents and non-writing operations. */
  writtenFiles?: string[];
}

export type FileEditResponse = FileEditSuccess | (EditFailure & {
  file?: string;
  dryRun?: boolean;
  written?: false;
});
