// editor/api/proposal-sharded.ts — proposal support for sharded ProjectShells.
//
// A shell proposal stores hunks over the same sparse logical document the
// sharded edit API uses ({kind, shell, shards}): /shell/... and
// /shards/<entry>/... JSON Pointer paths. Only the shards a proposal touches
// are loaded, so proposing on a large project reads the same handful of
// files a direct edit would. The QA gate materializes the full document
// once. The module is logic-only: the caller (proposals.ts) owns file IO,
// locking and sidecar persistence.

import { createHash } from "node:crypto";

import {
  executeShardedEditOperationOnValidatedShell,
  loadValidatedProjectShell,
  loadValidatedMapShard,
  shardEntriesForOperation,
  shardEncodingOf,
  serializeShard,
  SHARDED_DOCUMENT_KIND,
  type ShardEncoding,
} from "./sharded.ts";
import {
  applyProposalChanges,
  assessHunkValue,
  parseProposal,
  ProposalError,
  type ProposalAssetLookup,
} from "../proposals/model.ts";
import type { ProposalAssessment } from "../proposals/types.ts";
import {
  qaNewErrors,
  qaReportForValidatedProject,
  qaWithBaseline,
  qaWithStoredBaseline,
  type QaReport,
} from "../proposals/qa.ts";
import { diffJson, EditApiError, envelopeArg, executeEditOperation, parseBatchOperations } from "./operations.ts";
import { deepClone } from "../../src/engine/clone.ts";
import { semanticEqual } from "../engine/document.ts";
import { canonicalJson } from "../../src/engine/save.ts";
import {
  canonicalMapJson,
  decodeMapEntryText,
  MAP_SCHEMA_HASH,
  mapManifestHash,
  resolveMapManifestHash,
  sha256Text,
  validateMapDefStructure,
} from "../../src/engine/map-repository.ts";
import type { MapDef, Project, ProjectShell } from "../../src/engine/types.ts";
import type { EditProposal, ProposalAsset, ProposalRequest } from "../proposals/types.ts";

interface SparseShardedDocument {
  kind: typeof SHARDED_DOCUMENT_KIND;
  shell: ProjectShell;
  shards: Record<string, MapDef>;
}

function nativeSha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function nativeSemanticHash(value: unknown): string {
  return nativeSha256Text(canonicalJson(value));
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new EditApiError("INVALID_ARGUMENT", `${name} must be a non-empty string`, `$.${name}`, "non-empty string", value);
  }
  return value;
}

function integerArg(args: Record<string, unknown>, name: string, min: number, max: number): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new EditApiError("INVALID_ARGUMENT", `${name} must be an integer in [${min}, ${max}]`, `$.${name}`, `integer ${min}..${max}`, value);
  }
  return value;
}

const CONNECT_TRIGGERS = new Set(["action", "playerTouch", "eventTouch"]);
const STRUCTURAL_SHELL_COMMANDS = new Set(["add-map", "duplicate-map", "delete-map", "move-map"]);

/** Expand proposal-only macros into typed edit operations. `connect-maps`
 * creates a transfer event on one map that lands on another; it validates
 * against the live map index so a missing map or an out-of-bounds landing
 * fails at proposal time, not after acceptance. The macro expands to a
 * plain `add-event`, so the resulting hunk diff is ordinary event data. */
export function expandProposalMacro(
  command: string,
  args: Record<string, unknown>,
  maps: readonly { id: string; width: number; height: number }[],
): { command: string; args: Record<string, unknown> }[] {
  if (command !== "connect-maps") return [{ command, args }];
  const mapId = stringArg(args, "map");
  const targetId = stringArg(args, "targetMap");
  const from = maps.find((m) => m.id === mapId);
  if (from === undefined) {
    throw new EditApiError("MAP_NOT_FOUND", `connect-maps source map ${JSON.stringify(mapId)} does not exist`, "$.map", maps.map((m) => m.id), mapId);
  }
  const to = maps.find((m) => m.id === targetId);
  if (to === undefined) {
    throw new EditApiError("MAP_NOT_FOUND", `connect-maps target map ${JSON.stringify(targetId)} does not exist`, "$.targetMap", maps.map((m) => m.id), targetId);
  }
  const x = integerArg(args, "x", 0, from.width - 1);
  const y = integerArg(args, "y", 0, from.height - 1);
  const tx = integerArg(args, "targetX", 0, to.width - 1);
  const ty = integerArg(args, "targetY", 0, to.height - 1);
  const trigger = args.trigger === undefined ? "playerTouch" : stringArg(args, "trigger");
  if (!CONNECT_TRIGGERS.has(trigger)) {
    throw new EditApiError("INVALID_ARGUMENT", `trigger must be one of ${[...CONNECT_TRIGGERS].join(", ")}`, "$.trigger", [...CONNECT_TRIGGERS], trigger);
  }
  const eventId = args.eventId === undefined ? `connect-${mapId}-to-${targetId}` : stringArg(args, "eventId");
  if (!/^[A-Za-z0-9_-]+$/.test(eventId)) {
    throw new EditApiError("INVALID_ARGUMENT", "eventId must match ^[A-Za-z0-9_-]+$", "$.eventId", "letters, digits, underscore, or hyphen", eventId);
  }
  const event = {
    id: eventId,
    x,
    y,
    pages: [{ trigger, commands: [{ op: "transfer", map: targetId, x: tx, y: ty }] }],
  };
  return [{ command: "add-event", args: { map: mapId, event } }];
}

/** A proposal targets a shell when its changes touch /shell or /shards.
 * Inline projects have no such fields, so the path prefix is unambiguous. */
export function isShardedProposal(proposal: EditProposal): boolean {
  return proposal.hunks.some((hunk) =>
    hunk.changes.some((change) => change.path === "/shell" || change.path.startsWith("/shell/") || change.path.startsWith("/shards/")));
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Stable shard entries a proposal's changes touch, derived from pointer
 * paths. Entry keys are JSON-Pointer escaped, so `/` decodes from `~1`. */
export function shardEntriesForProposal(proposal: EditProposal): string[] {
  const entries = new Set<string>();
  for (const hunk of proposal.hunks) {
    for (const change of hunk.changes) {
      const match = /^\/shards\/([^/]+)/.exec(change.path);
      if (match !== null) entries.add(unescapePointerToken(match[1]!));
    }
  }
  return [...entries].sort();
}

function sparseDocument(
  shell: ProjectShell,
  shardTexts: Record<string, string>,
  trustedOperationOutput = false,
): SparseShardedDocument {
  const shards: Record<string, MapDef> = {};
  for (const [entry, text] of Object.entries(shardTexts)) {
    if (!trustedOperationOutput) {
      shards[entry] = loadValidatedMapShard(shell, entry, text);
      continue;
    }
    const meta = shell.mapIndex.find((item) => item.entry === entry);
    if (meta === undefined) throw new ProposalError("INVALID_PROPOSAL_RESULT", `shell no longer indexes ${JSON.stringify(entry)}`, `/shards/${entry}`);
    const decoded = decodeMapEntryText(text);
    validateMapDefStructure(decoded);
    const map = decoded as MapDef;
    if (map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
      throw new ProposalError("INVALID_PROPOSAL_RESULT", `operation output metadata mismatch for ${JSON.stringify(entry)}`, `/shards/${entry}`);
    }
    shards[entry] = map;
  }
  return { kind: SHARDED_DOCUMENT_KIND, shell, shards };
}

function serializeShellText(shell: ProjectShell): string {
  return `${JSON.stringify(shell, null, 2)}\n`;
}

/** Shell metadata is derived: mapIndex checksums/dimensions and the manifest
 * are pure functions of the shards. Hunks therefore store only shard changes
 * (and genuine shell-global changes such as a rename's start-map rewrite),
 * and acceptance rebuilds the metadata. This keeps hunks on different shards
 * from overlapping on /shell/mapManifestHash. */
const DERIVED_SHELL_PATHS = ["/shell/mapIndex", "/shell/mapSchemaHash", "/shell/mapManifestHash"];

function isDerivedShellPath(path: string): boolean {
  return DERIVED_SHELL_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function rebuildShellMetadata(
  shell: ProjectShell,
  shards: Record<string, MapDef>,
  beforeShards: Record<string, MapDef> = {},
  encodings?: ReadonlyMap<string, ShardEncoding>,
): ProjectShell {
  const mapIndex = shell.mapIndex.map((meta) => {
    const map = shards[meta.entry];
    if (map === undefined) return { ...meta };
    const before = beforeShards[meta.entry];
    if (before !== undefined && semanticEqual(before, map)) return { ...meta };
    const text = serializeShard(map, encodings?.get(meta.entry) ?? "json");
    return {
      ...meta,
      id: map.id,
      width: map.width,
      height: map.height,
      sha256: nativeSha256Text(text),
    };
  });
  const next: ProjectShell = { ...shell, mapIndex, mapSchemaHash: MAP_SCHEMA_HASH };
  delete next.mapManifestHash;
  next.mapManifestHash = mapManifestHash(next);
  return next;
}

function validateShardEvents(map: MapDef, fail: (message: string) => never): void {
  const eventIds = new Set<string>();
  for (const [eventIndex, event] of (map.events ?? []).entries()) {
    if (eventIds.has(event.id)) fail(`duplicate event id ${JSON.stringify(event.id)}`);
    eventIds.add(event.id);
    const width = event.w ?? 1;
    const height = event.h ?? 1;
    if (event.x + width > map.width || event.y + height > map.height) {
      fail(`event ${eventIndex} footprint is outside ${map.id} ${map.width}x${map.height}`);
    }
  }
}

/** Validate a merged proposal result: the shell must pass its own strict
 * gate (schema, index, manifest, start map), and every shard the proposal
 * wrote must match the shell's mapIndex metadata and checksum. */
function validateShardedSparseDocument(doc: SparseShardedDocument, validateShell = true): void {
  if (validateShell) loadValidatedProjectShell(serializeShellText(doc.shell));
  for (const [entry, map] of Object.entries(doc.shards)) {
    const meta = doc.shell.mapIndex.find((item) => item.entry === entry);
    if (meta === undefined) {
      throw new ProposalError("INVALID_PROPOSAL_RESULT", `result shell no longer indexes shard ${JSON.stringify(entry)}`, `/shards/${entry}`);
    }
    try {
      // Every proposal operation already passed the normative schema gate.
      // The merged sparse result only needs the cross-operation structural
      // invariants that could change when otherwise valid hunks are combined.
      validateMapDefStructure(map);
    } catch (error) {
      throw new ProposalError(
        "INVALID_PROPOSAL_RESULT",
        `proposal result shard ${JSON.stringify(entry)} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        `/shards/${entry}`,
      );
    }
    if (map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
      throw new ProposalError(
        "INVALID_PROPOSAL_RESULT",
        `result shard ${JSON.stringify(entry)} metadata does not match the shell mapIndex`,
        `/shards/${entry}`,
        `${meta.id} ${meta.width}x${meta.height}`,
        `${map.id} ${map.width}x${map.height}`,
      );
    }
    validateShardEvents(map, (message) => {
      throw new ProposalError("INVALID_PROPOSAL_RESULT", `proposal result shard ${JSON.stringify(entry)}: ${message}`, `/shards/${entry}`);
    });
  }
}

function placeholderMap(meta: ProjectShell["mapIndex"][number], shell: ProjectShell): MapDef {
  return {
    id: meta.id,
    name: meta.id,
    width: 1,
    height: 1,
    sheets: [shell.sheets[0]!.id],
    ground: [null],
    events: [],
  };
}

function projectForStructuralOperation(
  shell: ProjectShell,
  shards: Record<string, string>,
): Project {
  const loaded = new Map<string, MapDef>();
  for (const [entry, text] of Object.entries(shards)) {
    if (shell.mapIndex.some((meta) => meta.entry === entry)) {
      loaded.set(entry, loadValidatedMapShard(shell, entry, text));
    }
  }
  const maps = shell.mapIndex.map((meta) => loaded.get(meta.entry) ?? placeholderMap(meta, shell));
  const { mapIndex: _index, mapManifestHash: _manifest, mapSchemaHash: _schema, ...globals } = shell;
  return {
    ...deepClone(globals),
    start: { map: maps[0]!.id, x: 0, y: 0, dir: globals.start.dir },
    maps,
  } as Project;
}

function freshEntry(shell: ProjectShell, id: string): string {
  const used = new Set(shell.mapIndex.map((meta) => meta.entry));
  let suffix = 1;
  let entry = `maps/${id}.json`;
  while (used.has(entry)) entry = `maps/${id}-${suffix++}.json`;
  return entry;
}

function structuralEntries(shell: ProjectShell, command: string, args: Record<string, unknown>): string[] {
  if (command === "add-map" || command === "move-map") return [];
  const id = stringArg(args, "map");
  const meta = shell.mapIndex.find((item) => item.id === id);
  if (meta === undefined) {
    throw new EditApiError("MAP_NOT_FOUND", `map ${JSON.stringify(id)} does not exist`, "$.map", shell.mapIndex.map((item) => item.id), id);
  }
  return [meta.entry];
}

/** Proposal-only structural shell execution. Direct patch-v1 editing keeps
 * stable shard keys; a reviewed proposal can add/remove/reorder mapIndex and
 * carries the new shard object in its own reversible sparse-document diff. */
function executeStructuralProposalOperation(
  shellSource: string,
  shardTexts: Record<string, string>,
  command: string,
  args: Record<string, unknown>,
): { shell: string; shards: Record<string, string>; touched: string[] } {
  const shell = loadValidatedProjectShell(shellSource);
  const project = projectForStructuralOperation(shell, shardTexts);
  const execution = executeEditOperation(JSON.stringify(project), command, args);
  if (!execution.response.ok) {
    throw new EditApiError(
      execution.response.error.code,
      execution.response.error.message,
      execution.response.error.path,
      execution.response.error.expected,
      execution.response.error.actual,
      execution.response.error.details,
    );
  }
  if (execution.output === undefined) throw new EditApiError("INVALID_PROPOSAL_OPERATION", `${command} produced no edited document`);
  const edited = JSON.parse(execution.output) as Project;
  const oldById = new Map(shell.mapIndex.map((meta) => [meta.id, meta]));
  const nextShards = { ...shardTexts };
  const touched: string[] = [];
  const mapIndex = edited.maps.map((map) => {
    const prior = oldById.get(map.id);
    if (prior !== undefined) return { ...prior };
    const entry = freshEntry({ ...shell, mapIndex: [
      ...shell.mapIndex,
      ...touched.map((path) => ({ id: path, width: 1, height: 1, entry: path, sha256: "0".repeat(64) })),
    ] }, map.id);
    const text = canonicalMapJson(map);
    nextShards[entry] = text;
    touched.push(entry);
    return { id: map.id, width: map.width, height: map.height, entry, sha256: sha256Text(text) };
  });
  const retained = new Set(mapIndex.map((meta) => meta.entry));
  for (const meta of shell.mapIndex) {
    if (!retained.has(meta.entry) && Object.hasOwn(nextShards, meta.entry)) delete nextShards[meta.entry];
  }
  const next: ProjectShell = { ...deepClone(shell), mapIndex, mapSchemaHash: MAP_SCHEMA_HASH };
  delete next.mapManifestHash;
  next.mapManifestHash = mapManifestHash(next);
  return { shell: serializeShellText(next), shards: nextShards, touched };
}

function materializeProject(
  shell: ProjectShell,
  afterShards: Record<string, MapDef>,
  loadShard: (entry: string) => string,
  cache: Map<string, MapDef> = new Map(),
): Project {
  const maps = shell.mapIndex.map((meta) => {
    const changed = afterShards[meta.entry];
    if (changed !== undefined) return changed;
    const key = `${meta.entry}\0${meta.sha256}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let decoded: unknown;
    try {
      const text = loadShard(meta.entry);
      if (nativeSha256Text(text) !== meta.sha256) {
        throw new Error(`checksum mismatch for ${meta.id}`);
      }
      decoded = decodeMapEntryText(text);
      // Untouched entries are bound to the validated shell by their raw
      // checksum and current map-schema identity. Match the runtime repository
      // fast path here; proposal-created/edited maps were fully validated by
      // the operation path before entering afterShards.
      validateMapDefStructure(decoded);
    } catch (error) {
      throw new ProposalError(
        "INVALID_PROPOSAL_RESULT",
        `could not materialize shard ${JSON.stringify(meta.entry)} for QA: ${error instanceof Error ? error.message : String(error)}`,
        `/shards/${meta.entry}`,
      );
    }
    const map = decoded as MapDef;
    if (map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
      throw new ProposalError(
        "INVALID_PROPOSAL_RESULT",
        `QA shard ${JSON.stringify(meta.entry)} metadata does not match the shell mapIndex`,
        `/shards/${meta.entry}`,
      );
    }
    cache.set(key, map);
    return map;
  });
  const { mapIndex: _index, mapManifestHash: _manifest, mapSchemaHash: _schema, ...globals } = shell;
  // QA/lint is pure. Reuse the validated immutable shard objects instead of
  // cloning the entire multi-megabyte corpus twice for before/after reports.
  return { ...globals, start: { ...globals.start }, maps } as Project;
}

/** QA for a shell proposal: lint the fully materialized document (shell
 * globals plus every map), so reference and transfer-graph reachability
 * checks see the whole project. */
export function qaForShardedProposal(
  afterShell: ProjectShell,
  afterShards: Record<string, MapDef>,
  loadShard: (entry: string) => string,
  now: () => string = () => new Date().toISOString(),
): QaReport {
  return qaReportForValidatedProject(
    materializeProject(afterShell, afterShards, loadShard),
    resolveMapManifestHash(afterShell),
    now,
  );
}

/** Creation-time QA over both views. Untouched decoded maps are shared, so a
 * large shell is read once while errors introduced by the proposal remain
 * distinguishable from imported lint debt. */
export function qaForShardedProposalWithBaseline(
  beforeShell: ProjectShell,
  beforeShards: Record<string, MapDef>,
  afterShell: ProjectShell,
  afterShards: Record<string, MapDef>,
  loadShard: (entry: string) => string,
  proposalId: string,
  baseHash: string,
  now: () => string = () => new Date().toISOString(),
): QaReport {
  const cache = new Map<string, MapDef>();
  const before = qaReportForValidatedProject(
    materializeProject(beforeShell, beforeShards, loadShard, cache),
    resolveMapManifestHash(beforeShell),
    now,
  );
  const after = qaReportForValidatedProject(
    materializeProject(afterShell, afterShards, loadShard, cache),
    resolveMapManifestHash(afterShell),
    now,
  );
  return qaWithBaseline(after, before, proposalId, baseHash);
}

export interface ShardedProposalDryRun {
  proposal: EditProposal;
  beforeShell: ProjectShell;
  beforeShards: Record<string, MapDef>;
  afterShell: ProjectShell;
  afterShards: Record<string, MapDef>;
  touchedEntries: string[];
}

/** Dry-run a proposal request against a shell: each hunk's operations run
 * through the sharded edit API with only their touched shards loaded, and
 * the hunk diff is computed over the sparse logical document. */
export function dryRunShardedProposal(
  shellSource: string,
  loadShard: (entry: string) => string,
  request: ProposalRequest,
  now: () => string = () => new Date().toISOString(),
): ShardedProposalDryRun {
  const baseShell = loadValidatedProjectShell(shellSource);
  const touched = new Set<string>();
  const originalByEntry: Record<string, string> = {};
  const hunks = request.hunks.map((requestHunk, hunkIndex) => {
    let shellText = shellSource;
    let currentShell = baseShell;
    const shardTexts: Record<string, string> = {};
    const original: Record<string, string> = {};
    const assets = Object.create(null) as Record<string, ProposalAsset>;
    const load = (entry: string): string => {
      if (shardTexts[entry] === undefined) {
        const text = loadShard(entry);
        const meta = baseShell.mapIndex.find((item) => item.entry === entry);
        if (meta !== undefined && nativeSha256Text(text) !== meta.sha256) {
          throw new EditApiError("INVALID_DOCUMENT", `shard ${JSON.stringify(entry)} checksum mismatch`, `/shards/${entry}`);
        }
        shardTexts[entry] = text;
        original[entry] = text;
        if (originalByEntry[entry] === undefined) originalByEntry[entry] = text;
      }
      return shardTexts[entry]!;
    };
    // Whether any operation (including one inside a batch) added, removed,
    // duplicated or reordered a map. Structural changes keep /shell/mapIndex
    // in the hunk diff so the merged result carries the new index.
    let hunkStructural = false;
    const runProposalOp = (
      command: string,
      args: Record<string, unknown>,
      operationIndex: number,
      label: string,
    ): void => {
      const shell = currentShell;
      let expanded: { command: string; args: Record<string, unknown> }[];
      try {
        expanded = expandProposalMacro(command, args, shell.mapIndex);
      } catch (error) {
        throw wrapOperationError(error, hunkIndex, operationIndex);
      }
      for (let stepIndex = 0; stepIndex < expanded.length; stepIndex++) {
        const step = expanded[stepIndex]!;
        if (STRUCTURAL_SHELL_COMMANDS.has(step.command)) {
          hunkStructural = true;
          try {
            for (const entry of structuralEntries(shell, step.command, step.args)) {
              load(entry);
              touched.add(entry);
            }
            const structural = executeStructuralProposalOperation(shellText, shardTexts, step.command, step.args);
            shellText = structural.shell;
            currentShell = loadValidatedProjectShell(shellText);
            for (const key of Object.keys(shardTexts)) delete shardTexts[key];
            Object.assign(shardTexts, structural.shards);
            for (const entry of structural.touched) touched.add(entry);
            continue;
          } catch (error) {
            throw wrapOperationError(error, hunkIndex, operationIndex);
          }
        }
        let entries: string[];
        try {
          entries = shardEntriesForOperation(shell, step.command, step.args);
        } catch (error) {
          throw wrapOperationError(error, hunkIndex, operationIndex);
        }
        for (const entry of entries) {
          load(entry);
          touched.add(entry);
        }
        const execution = executeShardedEditOperationOnValidatedShell(
          shell,
          shardTexts,
          step.command,
          step.args,
          nativeSha256Text,
        );
        if (!execution.response.ok) {
          throw new EditApiError(
            "PROPOSAL_OPERATION_FAILED",
            `hunk ${JSON.stringify(requestHunk.id)} ${label}${expanded.length > 1 ? ` step ${stepIndex + 1}` : ""} failed: ${execution.response.error.message}`,
            `$.hunks[${hunkIndex}].operations[${operationIndex}]`,
            undefined,
            undefined,
            execution.response.error,
          );
        }
        if (execution.output !== undefined) {
          shellText = execution.output.shell;
          currentShell = JSON.parse(shellText) as ProjectShell;
          Object.assign(shardTexts, execution.output.shards);
        }
      }
    };
    for (let operationIndex = 0; operationIndex < requestHunk.operations.length; operationIndex++) {
      const operation = requestHunk.operations[operationIndex]!;
      if (operation.command === "add-asset") {
        const args = operation.args ?? {};
        const path = args.path;
        if (typeof path !== "string" || path.length === 0 || args.type !== "image/png" || typeof args.data !== "string" || args.data.length === 0 ||
            Object.keys(args).some((key) => key !== "path" && key !== "type" && key !== "data")) {
          throw new EditApiError(
            "INVALID_PROPOSAL_ASSET",
            "add-asset requires exactly non-empty path/data and type image/png",
            `$.hunks[${hunkIndex}].operations[${operationIndex}].args`,
          );
        }
        if (Object.hasOwn(assets, path)) {
          throw new EditApiError(
            "INVALID_PROPOSAL_ASSET",
            `asset ${JSON.stringify(path)} is added more than once in one hunk`,
            `$.hunks[${hunkIndex}].operations[${operationIndex}].args.path`,
          );
        }
        Object.defineProperty(assets, path, {
          value: { type: "image/png", data: args.data },
          enumerable: true,
          configurable: true,
          writable: true,
        });
        continue;
      }
      if (operation.command === "batch") {
        // Flatten the batch's inner operations through the same per-op path
        // so a proposal batch can use structural shell commands (add-map and
        // friends) just like a plain hunk operation. The dry-run is itself
        // all-or-nothing, preserving the batch's transaction semantics.
        const batchArgs: Record<string, unknown> = operation.args ?? {};
        let inner: ReturnType<typeof parseBatchOperations>;
        try {
          envelopeArg(batchArgs);
          inner = parseBatchOperations(batchArgs.operations);
        } catch (error) {
          throw wrapOperationError(error, hunkIndex, operationIndex);
        }
        for (let innerIndex = 0; innerIndex < inner.length; innerIndex++) {
          const step = inner[innerIndex]!;
          runProposalOp(step.command, step.args ?? {}, operationIndex, `operation ${operationIndex + 1} (batch step ${innerIndex + 1})`);
        }
        continue;
      }
      runProposalOp(operation.command, operation.args ?? {}, operationIndex, `operation ${operationIndex + 1}`);
    }
    const baseDoc = sparseDocument(baseShell, original, true);
    const afterShell = currentShell;
    const afterDoc = sparseDocument(afterShell, shardTexts, true);
    // Drop derived shell metadata from the hunk diff: it is rebuilt from the
    // shards at accept time, so hunks on different shards never overlap on it.
    const structural = hunkStructural;
    const changes = diffJson(baseDoc, afterDoc).filter((change) =>
      !isDerivedShellPath(change.path) || structural &&
        (change.path === "/shell/mapIndex" || change.path.startsWith("/shell/mapIndex/")));
    if (changes.length === 0 && Object.keys(assets).length === 0) {
      throw new EditApiError("EMPTY_PROPOSAL_HUNK", `hunk ${JSON.stringify(requestHunk.id)} makes no semantic change`, `$.hunks[${hunkIndex}]`);
    }
    return {
      id: requestHunk.id,
      summary: requestHunk.summary,
      changes,
      ...(Object.keys(assets).length === 0 ? {} : { assets }),
    };
  });

  const baseDoc = sparseDocument(baseShell, originalByEntry, true);
  const proposal = parseProposal({
    id: request.id,
    title: request.title,
    rationale: request.rationale,
    author: request.author,
    createdAt: request.createdAt,
    baseHash: nativeSemanticHash(baseDoc),
    hunks,
  });

  // Combined validity gate: every hunk applies to the shared base document
  // and the merged result, with shell metadata rebuilt, passes the shell's
  // own strict validation.
  const afterDoc = applyProposalChanges(baseDoc, hunks.flatMap((hunk) => hunk.changes)) as SparseShardedDocument;
  const encodings = new Map<string, ShardEncoding>(
    Object.entries(originalByEntry).map(([entry, text]) => [entry, shardEncodingOf(text)]),
  );
  afterDoc.shell = rebuildShellMetadata(afterDoc.shell, afterDoc.shards, baseDoc.shards, encodings);
  const structural = request.hunks.some((hunk) => hunk.operations.some((operation) => STRUCTURAL_SHELL_COMMANDS.has(operation.command)));
  validateShardedSparseDocument(afterDoc, structural);
  return {
    proposal,
    beforeShell: baseShell,
    beforeShards: baseDoc.shards,
    afterShell: afterDoc.shell,
    afterShards: afterDoc.shards,
    touchedEntries: [...touched].sort(),
  };
}

function wrapOperationError(error: unknown, hunkIndex: number, operationIndex: number): never {
  if (error instanceof EditApiError) {
    throw new EditApiError(
      error.code,
      error.message,
      `$.hunks[${hunkIndex}].operations[${operationIndex}]`,
      error.expected,
      error.actual,
      error.details,
    );
  }
  throw error;
}

/** Live per-hunk assessment against the current shell and shards. */
export function assessShardedProposal(
  shellSource: string,
  loadShard: (entry: string) => string,
  proposal: EditProposal,
  assetData?: ProposalAssetLookup,
): ProposalAssessment {
  const shell = loadValidatedProjectShell(shellSource);
  const entries = shardEntriesForProposal(proposal);
  const shardTexts: Record<string, string> = {};
  for (const entry of entries) {
    if (shell.mapIndex.some((meta) => meta.entry === entry)) shardTexts[entry] = loadShard(entry);
  }
  const doc = sparseDocument(shell, shardTexts);
  const hunks = proposal.hunks.map((hunk) => assessHunkValue(doc, hunk, assetData));
  return {
    baseMatches: nativeSemanticHash(doc) === proposal.baseHash,
    hasConflicts: hunks.some((hunk) => hunk.state === "conflict" || hunk.state === "partially-applied"),
    hunks,
  };
}

export interface ShardedAcceptResult {
  /** New shell text (unchanged bytes when no hunk applied). */
  shellText: string;
  /** New texts for shards whose bytes changed. */
  shardTexts: Record<string, string>;
  /** Bytes the write must expect for each target file. */
  originalShellText: string;
  originalShardTexts: Record<string, string>;
  /** Shard entries that left the mapIndex (e.g. delete-map); their files
   *  are orphans the caller should remove after publishing the shell. */
  removedEntries: string[];
  qa: QaReport;
  appliedHunks: string[];
  changed: boolean;
}

/** Apply every clean hunk of a shell proposal and QA the result. Returns
 * the texts to publish; the caller owns the transactional multi-file write.
 * Conflicting hunks and QA errors fail before any text is returned. */
export function acceptShardedProposal(
  shellSource: string,
  loadShard: (entry: string) => string,
  proposal: EditProposal,
  storedQa: QaReport | null = null,
  now: () => string = () => new Date().toISOString(),
  assetData?: ProposalAssetLookup,
): ShardedAcceptResult {
  const shell = loadValidatedProjectShell(shellSource);
  const entries = shardEntriesForProposal(proposal);
  const original: Record<string, string> = {};
  const shardTexts: Record<string, string> = {};
  for (const entry of entries) {
    if (shell.mapIndex.some((meta) => meta.entry === entry)) {
      const text = loadShard(entry);
      original[entry] = text;
      shardTexts[entry] = text;
    }
  }
  const baseDoc = sparseDocument(shell, original);
  const assessment = proposal.hunks.map((hunk) => assessHunkValue(baseDoc, hunk, assetData));
  const blocked = assessment.filter((hunk) => hunk.state === "conflict" || hunk.state === "partially-applied");
  if (blocked.length > 0) {
    throw new ProposalError(
      "PROPOSAL_HUNK_CONFLICT",
      `proposal ${JSON.stringify(proposal.id)} has conflicting hunks and cannot be accepted`,
      "$.hunks",
      "clean or already-applied",
      blocked.map((hunk) => hunk.id),
      blocked,
    );
  }
  const cleanIds = assessment.filter((hunk) => hunk.state === "clean").map((hunk) => hunk.id);
  const encodings = new Map<string, ShardEncoding>(
    Object.entries(original).map(([entry, text]) => [entry, shardEncodingOf(text)]),
  );
  let afterDoc = baseDoc;
  if (cleanIds.length > 0) {
    const changes = proposal.hunks
      .filter((hunk) => cleanIds.includes(hunk.id))
      .flatMap((hunk) => hunk.changes);
    afterDoc = applyProposalChanges(baseDoc, changes) as SparseShardedDocument;
    afterDoc.shell = rebuildShellMetadata(afterDoc.shell, afterDoc.shards, baseDoc.shards, encodings);
    validateShardedSparseDocument(afterDoc);
  }
  const qa = qaWithStoredBaseline(
    qaForShardedProposal(afterDoc.shell, afterDoc.shards, loadShard, now),
    storedQa,
    proposal.id,
    proposal.baseHash,
  );
  const introduced = qaNewErrors(qa, storedQa, proposal.id, proposal.baseHash);
  if (introduced.length > 0) {
    throw new ProposalError(
      "PROPOSAL_QA_FAILED",
      `proposal ${JSON.stringify(proposal.id)} introduces ${introduced.length} QA error finding(s)`,
      "$.hunks",
      "no errors beyond the proposal creation baseline",
      introduced.length,
      introduced,
    );
  }
  const shellText = serializeShellText(afterDoc.shell);
  const outShardTexts: Record<string, string> = {};
  for (const [entry, map] of Object.entries(afterDoc.shards)) {
    // Keep each shard's on-disk encoding: a compact .rkm shard is written
    // back compact, matching the mapIndex sha256 rebuilt above.
    const text = serializeShard(map, encodings.get(entry) ?? "json");
    if (text !== original[entry]) outShardTexts[entry] = text;
  }
  const retainedEntries = new Set(afterDoc.shell.mapIndex.map((meta) => meta.entry));
  const removedEntries = shell.mapIndex
    .map((meta) => meta.entry)
    .filter((entry) => !retainedEntries.has(entry));
  return {
    shellText,
    shardTexts: outShardTexts,
    originalShellText: shellSource,
    originalShardTexts: original,
    removedEntries,
    qa,
    appliedHunks: cleanIds,
    changed: shellText !== shellSource || Object.keys(outShardTexts).length > 0 || removedEntries.length > 0,
  };
}
