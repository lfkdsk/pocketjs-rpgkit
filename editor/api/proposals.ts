// Proposal generation and sidecar storage for CLI, MCP and the editor launcher.

import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Project } from "../../src/engine/types.ts";
import { serializeProject, serializeProjectPreservingSource } from "../engine/document.ts";
import { atomicWriteProjectFile, atomicWriteProjectFiles, confinedProjectNewShardPath, confinedProjectShardPath, withProjectFileLock, WriteConflictError, type AtomicReplacement } from "./file.ts";
import { FileLockBusyError, withFileLock } from "./lock.ts";
import {
  applyEditPatch,
  createEditPatch,
  diffJson,
  EditApiError,
  executeEditOperation,
  semanticHash,
} from "./operations.ts";
import {
  applyProposalHunks,
  assessHunk,
  assessProposal,
  decideProposalHunks,
  parseProposal,
  ProposalError,
  proposalComplete,
} from "../proposals/model.ts";
import {
  proposalQa,
  qaNewErrors,
  qaReportFor,
  qaSummary,
  qaWithBaseline,
  qaWithStoredBaseline,
  type QaReport,
} from "../proposals/qa.ts";
import type {
  EditProposal,
  ProposalAsset,
  ProposalRequest,
  ProposedOperation,
} from "../proposals/types.ts";
import {
  acceptShardedProposal,
  assessShardedProposal,
  dryRunShardedProposal,
  expandProposalMacro,
  qaForShardedProposal,
  qaForShardedProposalWithBaseline,
  shardEntriesForProposal,
} from "./proposal-sharded.ts";
import { sourceDeclaresProjectShell } from "./sharded.ts";
import { MAX_PNG_BYTES } from "./limits.ts";
import { decodeBase64, encodeBase64, packEntryProblem } from "./pack-format.ts";

export const PROPOSAL_COMMANDS = [
  "propose",
  "list-proposals",
  "show-proposal",
  "withdraw-proposal",
  "accept-proposal",
  "reject-proposal",
  "list-archive",
] as const;
export type ProposalCommandName = (typeof PROPOSAL_COMMANDS)[number];

export interface ProposalFileRequest {
  command: ProposalCommandName;
  file: string;
  args?: unknown;
  dryRun?: boolean;
  root?: string;
}

export interface ProposalFileSuccess {
  ok: true;
  command: ProposalCommandName;
  file: string;
  proposalDirectory: string;
  dryRun: boolean;
  written: boolean;
  result: unknown;
}

export interface ProposalFileFailure {
  ok: false;
  command: ProposalCommandName;
  file?: string;
  dryRun?: boolean;
  /** False when every mutation was rolled back. True means recovery could not
   * be verified and callers must inspect the listed paths before retrying. */
  written: boolean;
  error: {
    code: string;
    message: string;
    path?: string;
    expected?: unknown;
    actual?: unknown;
    details?: unknown;
  };
}

class ProposalPartialWriteError extends EditApiError {
  readonly written = true;
}

export type ProposalFileResponse = ProposalFileSuccess | ProposalFileFailure;

const MUTATION_COMMANDS = new Set([
  "add-item",
  "add-sprite",
  "add-asset",
  "update-map",
  "move-map",
  "add-map",
  "duplicate-map",
  "delete-map",
  "paint-tile",
  "paint-rect",
  "fill-region",
  "paint-passage",
  "add-event",
  "update-event",
  "delete-event",
  "add-page",
  "update-page",
  "delete-page",
  "insert-command",
  "delete-command",
  "update-command",
  "connect-maps",
]);

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EditApiError("INVALID_PROPOSAL_REQUEST", `${path} must be an object`, path, "object", value);
  }
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EditApiError("INVALID_PROPOSAL_REQUEST", `${path} must be a non-empty string`, path, "non-empty string", value);
  }
  return value;
}

function requestFrom(value: unknown, now: () => string): ProposalRequest {
  const input = record(value, "$");
  const allowed = new Set(["id", "title", "rationale", "author", "createdAt", "hunks"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new EditApiError("INVALID_PROPOSAL_REQUEST", `unknown proposal request field(s): ${unknown.join(", ")}`, "$", [...allowed], unknown);
  }
  if (!Array.isArray(input.hunks) || input.hunks.length === 0) {
    throw new EditApiError("INVALID_PROPOSAL_REQUEST", "$.hunks must be a non-empty array", "$.hunks", "non-empty array", input.hunks);
  }
  const hunks = input.hunks.map((rawHunk, hunkIndex) => {
    const hunk = record(rawHunk, `$.hunks[${hunkIndex}]`);
    const hunkAllowed = new Set(["id", "summary", "operations"]);
    const unknownHunk = Object.keys(hunk).filter((key) => !hunkAllowed.has(key));
    if (unknownHunk.length > 0) {
      throw new EditApiError("INVALID_PROPOSAL_REQUEST", `unknown hunk field(s): ${unknownHunk.join(", ")}`, `$.hunks[${hunkIndex}]`, [...hunkAllowed], unknownHunk);
    }
    if (!Array.isArray(hunk.operations) || hunk.operations.length === 0) {
      throw new EditApiError("INVALID_PROPOSAL_REQUEST", "hunk operations must be a non-empty array", `$.hunks[${hunkIndex}].operations`);
    }
    const operations = hunk.operations.map((rawOperation, operationIndex): ProposedOperation => {
      const path = `$.hunks[${hunkIndex}].operations[${operationIndex}]`;
      const operation = record(rawOperation, path);
      const operationUnknown = Object.keys(operation).filter((key) => key !== "command" && key !== "args");
      if (operationUnknown.length > 0) {
        throw new EditApiError("INVALID_PROPOSAL_REQUEST", `unknown operation field(s): ${operationUnknown.join(", ")}`, path);
      }
      const command = nonemptyString(operation.command, `${path}.command`);
      if (!MUTATION_COMMANDS.has(command)) {
        throw new EditApiError(
          "INVALID_PROPOSAL_OPERATION",
          `${path}.command must be an editing operation (save/read operations cannot form proposal hunks)`,
          `${path}.command`,
          [...MUTATION_COMMANDS],
          command,
        );
      }
      const args = operation.args === undefined ? {} : record(operation.args, `${path}.args`);
      return { command, args };
    });
    return {
      id: nonemptyString(hunk.id, `$.hunks[${hunkIndex}].id`),
      summary: nonemptyString(hunk.summary, `$.hunks[${hunkIndex}].summary`),
      operations,
    };
  });
  return {
    id: nonemptyString(input.id, "$.id"),
    title: nonemptyString(input.title, "$.title"),
    rationale: nonemptyString(input.rationale, "$.rationale"),
    author: nonemptyString(input.author, "$.author"),
    createdAt: input.createdAt === undefined ? now() : nonemptyString(input.createdAt, "$.createdAt"),
    hunks,
  };
}

function proposalAssetOperation(
  args: Record<string, unknown>,
  path: string,
): { path: string; asset: ProposalAsset } {
  const allowed = ["path", "type", "data"];
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new EditApiError("INVALID_PROPOSAL_ASSET", `unknown add-asset argument(s): ${unknown.join(", ")}`, path, allowed, unknown);
  }
  const assetPath = nonemptyString(args.path, `${path}.path`);
  if (args.type !== "image/png") {
    throw new EditApiError("INVALID_PROPOSAL_ASSET", "add-asset type must be image/png", `${path}.type`, "image/png", args.type);
  }
  const data = nonemptyString(args.data, `${path}.data`);
  return { path: assetPath, asset: { type: "image/png", data } };
}

function projectFromSource(source: string): Project {
  const opened = executeEditOperation(source, "open");
  if (!opened.response.ok) throw new EditApiError(
    opened.response.error.code,
    opened.response.error.message,
    opened.response.error.path,
    opened.response.error.expected,
    opened.response.error.actual,
    opened.response.error.details,
  );
  if (opened.response.project.documentKind !== "inline") {
    throw new EditApiError("READ_ONLY_PROJECT_SHELL", "proposals currently require an inline project", "$.mapIndex", "inline project with $.maps");
  }
  return JSON.parse(source) as Project;
}

/** Dry-run explicit operation groups against the same base. Operations inside
 * one hunk may depend on each other; different hunks must remain independent. */
export function createProposalFromOperations(
  source: string,
  requestValue: unknown,
  now: () => string = () => new Date().toISOString(),
): EditProposal {
  const base = projectFromSource(source);
  const request = requestFrom(requestValue, now);
  const hunks = request.hunks.map((requestHunk, hunkIndex) => {
    let hunkSource = source;
    const assets = Object.create(null) as Record<string, ProposalAsset>;
    for (let operationIndex = 0; operationIndex < requestHunk.operations.length; operationIndex++) {
      const operation = requestHunk.operations[operationIndex]!;
      if (operation.command === "add-asset") {
        const operationPath = `$.hunks[${hunkIndex}].operations[${operationIndex}].args`;
        const attachment = proposalAssetOperation(operation.args ?? {}, operationPath);
        if (Object.hasOwn(assets, attachment.path)) {
          throw new EditApiError("INVALID_PROPOSAL_ASSET", `asset ${JSON.stringify(attachment.path)} is added more than once in one hunk`, operationPath);
        }
        Object.defineProperty(assets, attachment.path, {
          value: attachment.asset,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        continue;
      }
      const maps = (JSON.parse(hunkSource) as Project).maps;
      const expanded = expandProposalMacro(operation.command, operation.args ?? {}, maps);
      for (let stepIndex = 0; stepIndex < expanded.length; stepIndex++) {
        const step = expanded[stepIndex]!;
        const execution = executeEditOperation(hunkSource, step.command, step.args ?? {});
        if (!execution.response.ok) {
          throw new EditApiError(
            "PROPOSAL_OPERATION_FAILED",
            `hunk ${JSON.stringify(requestHunk.id)} operation ${operationIndex + 1}${expanded.length > 1 ? ` step ${stepIndex + 1}` : ""} failed: ${execution.response.error.message}`,
            `$.hunks[${hunkIndex}].operations[${operationIndex}]`,
            undefined,
            undefined,
            execution.response.error,
          );
        }
        if (execution.output === undefined) {
          throw new EditApiError("INVALID_PROPOSAL_OPERATION", `${step.command} did not produce an edited document`);
        }
        hunkSource = execution.output;
      }
    }
    const changes = diffJson(base, JSON.parse(hunkSource));
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
  const proposal = parseProposal({
    id: request.id,
    title: request.title,
    rationale: request.rationale,
    author: request.author,
    createdAt: request.createdAt,
    baseHash: semanticHash(base),
    hunks,
  });

  // This is both a combined validity gate and a direct guarantee that the
  // proposal's unchanged EditChange payload can form a normal AI1 patch.
  const after = applyProposalHunks(base, proposal, hunks.map((hunk) => hunk.id));
  const changes = hunks.flatMap((hunk) => hunk.changes);
  const patch = {
    ...createEditPatch(base, after),
    changes,
  };
  applyEditPatch(base, patch);
  const validated = executeEditOperation(serializeProject(after), "validate");
  if (!validated.response.ok || !(validated.response.result as { valid?: boolean }).valid) {
    throw new EditApiError("INVALID_PROPOSAL", "combined proposal did not pass project validation", "$.hunks");
  }
  return proposal;
}

export function proposalDirectoryFor(projectFile: string): string {
  return `${projectFile}.proposals`;
}

export function proposalArchiveDirectoryFor(projectFile: string): string {
  return join(proposalDirectoryFor(projectFile), "archive");
}

function safeId(id: unknown): string {
  const text = nonemptyString(id, "$.id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text)) {
    throw new EditApiError("INVALID_PROPOSAL_ID", "proposal id must be filesystem-safe", "$.id", "[A-Za-z0-9][A-Za-z0-9._-]{0,127}", text);
  }
  return text;
}

function proposalPath(projectFile: string, id: string, archived = false): string {
  return join(archived ? proposalArchiveDirectoryFor(projectFile) : proposalDirectoryFor(projectFile), `${id}.json`);
}

function qaSidecarPath(projectFile: string, id: string, archived = false): string {
  return join(archived ? proposalArchiveDirectoryFor(projectFile) : proposalDirectoryFor(projectFile), "qa", `${id}.json`);
}

/** EDX3 originally wrote `<id>.qa.json` beside pending proposals. Keep a
 * read-only fallback so queues made by that build remain usable, but never
 * create another file in the legacy reader's `*.json` namespace. */
function legacyQaSidecarPath(projectFile: string, id: string, archived = false): string {
  return join(archived ? proposalArchiveDirectoryFor(projectFile) : proposalDirectoryFor(projectFile), `${id}.qa.json`);
}

function readQaSidecar(projectFile: string, id: string, archived: boolean): QaReport | null {
  for (const path of [qaSidecarPath(projectFile, id, archived), legacyQaSidecarPath(projectFile, id, archived)]) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as QaReport;
    } catch {
      return null;
    }
  }
  return null;
}

function writeQaSidecar(projectFile: string, id: string, report: QaReport, archived: boolean): void {
  atomicReplace(qaSidecarPath(projectFile, id, archived), `${JSON.stringify(report, null, 2)}\n`);
}

/** Compact diff overview for the archive history view. */
function diffSummary(proposal: EditProposal): { hunks: number; changes: number; assets: number; paths: string[] } {
  const paths = new Set<string>();
  let changes = 0;
  let assets = 0;
  for (const hunk of proposal.hunks) {
    for (const change of hunk.changes) {
      changes++;
      paths.add(change.path || "$");
    }
    for (const path of Object.keys(hunk.assets ?? {})) {
      assets++;
      paths.add(`asset:${path}`);
    }
  }
  return { hunks: proposal.hunks.length, changes, assets, paths: [...paths].sort() };
}

function decisionOf(proposal: EditProposal): { status: "accepted" | "rejected" | "mixed"; decidedAt: string; source?: string } {
  const decisions = proposal.hunks.map((hunk) => hunk.decision!);
  const statuses = new Set(decisions.map((decision) => decision.status));
  const status = statuses.size === 1 ? decisions[0]!.status : "mixed";
  const source = decisions.find((decision) => decision.source !== undefined)?.source;
  return {
    status,
    decidedAt: decisions.map((decision) => decision.decidedAt).sort().at(-1)!,
    ...(source === undefined ? {} : { source }),
  };
}

function assertStorageDirectory(projectFile: string, create: boolean): void {
  const directory = proposalDirectoryFor(projectFile);
  const archive = proposalArchiveDirectoryFor(projectFile);
  const qa = join(directory, "qa");
  const archiveQa = join(archive, "qa");
  for (const path of [directory, archive, qa, archiveQa]) {
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new EditApiError("UNSAFE_PROPOSAL_PATH", `proposal storage path must be a real directory: ${path}`, path);
      }
    } else if (create) {
      mkdirSync(path, { recursive: true });
    }
  }
}

function atomicReplace(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (existsSync(path)) chmodSync(temporary, statSync(path).mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function atomicCreate(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    if (typeof data === "string") {
      writeFileSync(temporary, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } else {
      writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
    }
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Serialize sidecar transitions across CLI/bridge processes. A dead owner's
 * lock is reclaimed; a live owner fails fast instead of allowing last-writer
 * wins to reverse or lose decisions. */
function withStorageLock<T>(projectFile: string, key: string, run: () => T): T {
  assertStorageDirectory(projectFile, true);
  const path = join(proposalDirectoryFor(projectFile), `.lock-${key}`);
  try {
    return withFileLock(path, run);
  } catch (error) {
    if (error instanceof FileLockBusyError) {
      throw new EditApiError("PROPOSAL_BUSY", `proposal storage is busy for ${JSON.stringify(key)}`, path);
    }
    throw error;
  }
}

function resolveProjectFile(file: string, root?: string): string {
  const project = realpathSync(resolve(file));
  if (root !== undefined) {
    const realRoot = realpathSync(resolve(root));
    const fromRoot = relative(realRoot, project);
    if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
      throw new EditApiError("PATH_OUTSIDE_ROOT", `path is outside the configured project root ${realRoot}`, project);
    }
  }
  return project;
}

function pathOutside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot);
}

/** Resolve an attachment path without following symlink components. Missing
 * parent directories are allowed and are created only during acceptance. */
function proposalAssetTarget(projectFile: string, assetPath: string): { root: string; target: string } {
  if (packEntryProblem(assetPath) !== null) {
    throw new EditApiError("INVALID_PROPOSAL_ASSET", `unsafe proposal asset path ${JSON.stringify(assetPath)}`, "$.hunks[].assets");
  }
  const root = realpathSync(dirname(projectFile));
  const parts = assetPath.split("/");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    const next = join(cursor, part);
    if (!existsSync(next)) {
      cursor = next;
      continue;
    }
    const info = lstatSync(next);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new EditApiError("UNSAFE_PROPOSAL_PATH", `proposal asset parent must be a real directory: ${next}`, next);
    }
    cursor = realpathSync(next);
    if (pathOutside(root, cursor)) {
      throw new EditApiError("UNSAFE_PROPOSAL_PATH", `proposal asset path escapes the project directory: ${assetPath}`, next);
    }
  }
  const target = resolve(root, ...parts);
  if (pathOutside(root, target) || target === projectFile) {
    throw new EditApiError("UNSAFE_PROPOSAL_PATH", `proposal asset path escapes or replaces the project file: ${assetPath}`, target);
  }
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new EditApiError("UNSAFE_PROPOSAL_PATH", `proposal asset target must be a real file: ${target}`, target);
    }
  }
  return { root, target };
}

function proposalAssetData(projectFile: string, assetPath: string): string | null {
  const { target } = proposalAssetTarget(projectFile, assetPath);
  if (!existsSync(target)) return null;
  // Differing oversized files are conflicts without allocating their bytes.
  if (statSync(target).size > MAX_PNG_BYTES) return "!oversized-existing-asset";
  return encodeBase64(readFileSync(target));
}

function assetLookupFor(projectFile: string): (path: string) => string | null {
  return (path) => proposalAssetData(projectFile, path);
}

interface PublishedProposalAsset {
  path: string;
  data: string;
}

function ensureAssetParents(root: string, target: string, createdDirectories: string[]): void {
  const parent = dirname(target);
  const parts = relative(root, parent).split(/[\\/]+/).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (existsSync(cursor)) {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new EditApiError("UNSAFE_PROPOSAL_PATH", `proposal asset parent must be a real directory: ${cursor}`, cursor);
      }
      continue;
    }
    mkdirSync(cursor, { mode: 0o700 });
    createdDirectories.push(cursor);
  }
}

function publishProposalAssets(
  projectFile: string,
  proposal: EditProposal,
  cleanHunkIds: readonly string[],
  published: PublishedProposalAsset[],
  createdDirectories: string[],
): void {
  const wanted = new Set(cleanHunkIds);
  for (const hunk of proposal.hunks) {
    if (!wanted.has(hunk.id)) continue;
    for (const [assetPath, asset] of Object.entries(hunk.assets ?? {})) {
      const { root, target } = proposalAssetTarget(projectFile, assetPath);
      if (existsSync(target)) {
        throw new WriteConflictError(`proposal asset appeared before publication: ${target}`);
      }
      const bytes = decodeBase64(asset.data);
      if (bytes === null) throw new EditApiError("INVALID_PROPOSAL_ASSET", `proposal asset ${JSON.stringify(assetPath)} is not valid base64`, `asset:${assetPath}`);
      ensureAssetParents(root, target, createdDirectories);
      // Re-resolve after directory creation to catch a raced symlink.
      const checked = proposalAssetTarget(projectFile, assetPath).target;
      atomicCreate(checked, bytes);
      published.push({ path: checked, data: asset.data });
    }
  }
}

function rollbackProposalAssets(
  published: readonly PublishedProposalAsset[],
  createdDirectories: readonly string[],
): void {
  for (const asset of [...published].reverse()) {
    if (!existsSync(asset.path)) continue;
    const info = lstatSync(asset.path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_PNG_BYTES || encodeBase64(readFileSync(asset.path)) !== asset.data) {
      throw new Error(`published asset changed before rollback: ${asset.path}`);
    }
    rmSync(asset.path);
  }
  for (const directory of [...createdDirectories].reverse()) {
    if (!existsSync(directory)) continue;
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`created asset directory changed before rollback: ${directory}`);
    rmdirSync(directory);
  }
}

function readProposalPath(path: string, expectedId?: string): EditProposal {
  let value: unknown;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error("proposal files may not be symbolic links");
    }
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new EditApiError("INVALID_PROPOSAL", `could not read proposal ${path}: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  const proposal = parseProposal(value);
  if (expectedId !== undefined && proposal.id !== expectedId) {
    throw new EditApiError(
      "INVALID_PROPOSAL",
      `proposal file name does not match its id ${JSON.stringify(proposal.id)}`,
      path,
      expectedId,
      proposal.id,
    );
  }
  return proposal;
}

function proposalWithoutDecisions(proposal: EditProposal): EditProposal {
  return {
    ...proposal,
    hunks: proposal.hunks.map(({ decision: _decision, ...hunk }) => hunk),
  };
}

/** Review persistence may only add decisions to the immutable proposal that
 * is already queued. This keeps a compromised/stale guest snapshot from
 * rewriting the operation payload or reversing a decision. */
function mergeReviewTransition(previous: EditProposal, next: EditProposal): EditProposal {
  if (semanticHash(proposalWithoutDecisions(previous)) !== semanticHash(proposalWithoutDecisions(next))) {
    throw new EditApiError(
      "INVALID_PROPOSAL_REVIEW",
      "review may not change proposal metadata, hunks, or edit changes",
      "$.proposal",
    );
  }
  const merged = structuredClone(next);
  for (let index = 0; index < previous.hunks.length; index++) {
    const before = previous.hunks[index]!.decision;
    const after = next.hunks[index]!.decision;
    if (before !== undefined && after !== undefined && JSON.stringify(before) !== JSON.stringify(after)) {
      throw new EditApiError(
        "INVALID_PROPOSAL_REVIEW",
        `review may not change the existing decision for hunk ${JSON.stringify(previous.hunks[index]!.id)}`,
        `$.hunks[${index}].decision`,
        before,
        after,
      );
    }
    if (before !== undefined && after === undefined) merged.hunks[index]!.decision = structuredClone(before);
  }
  return parseProposal(merged);
}

export function loadPendingProposals(projectFile: string): EditProposal[] {
  const directory = proposalDirectoryFor(projectFile);
  if (!existsSync(directory)) return [];
  assertStorageDirectory(projectFile, false);
  const files = Array.from(new Bun.Glob("*.json").scanSync({ cwd: directory, onlyFiles: true }))
    // Legacy QA files remain ignored while they are migrated on the next
    // lifecycle transition. A proposal id ending in `.qa` is no longer
    // ambiguous because new QA lives in the qa/ directory.
    .filter((name) => !name.endsWith(".qa.json") || existsSync(join(directory, "qa", name)))
    .sort();
  const pending: EditProposal[] = [];
  for (const name of files) {
    const id = name.slice(0, -".json".length);
    const path = join(directory, name);
    const proposal = readProposalPath(path, id);
    if (!proposalComplete(proposal)) {
      pending.push(proposal);
      continue;
    }
    // Recover the only non-atomic boundary in archival (archive creation ->
    // pending removal). This also repairs files produced by older versions.
    withStorageLock(projectFile, id, () => {
      if (!existsSync(path)) return;
      const current = readProposalPath(path, id);
      if (!proposalComplete(current)) return;
      archiveWithQa(projectFile, id, current, readQaSidecar(projectFile, id, false));
    });
  }
  return pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function persistMergedReview(projectFile: string, pending: string, proposal: EditProposal): string {
  const text = `${JSON.stringify(proposal, null, 2)}\n`;
  if (!proposalComplete(proposal)) {
    atomicReplace(pending, text);
    return pending;
  }
  const archived = proposalPath(projectFile, proposal.id, true);
  if (existsSync(archived)) {
    const prior = readProposalPath(archived, proposal.id);
    if (semanticHash(prior) !== semanticHash(proposal)) {
      throw new EditApiError("PROPOSAL_ALREADY_EXISTS", `archived proposal ${JSON.stringify(proposal.id)} has different content`, "$.id");
    }
  } else {
    atomicCreate(archived, text);
  }
  rmSync(pending, { force: true });
  return archived;
}

function assertArchiveCompatible(projectFile: string, proposal: EditProposal): void {
  const archived = proposalPath(projectFile, proposal.id, true);
  if (!existsSync(archived)) return;
  const prior = readProposalPath(archived, proposal.id);
  if (semanticHash(prior) !== semanticHash(proposal)) {
    throw new EditApiError("PROPOSAL_ALREADY_EXISTS", `archived proposal ${JSON.stringify(proposal.id)} has different content`, "$.id");
  }
}

function persistReviewedProposalLocked(projectFile: string, proposal: EditProposal): { path: string; proposal: EditProposal } {
  const pending = proposalPath(projectFile, proposal.id);
  if (!existsSync(pending)) {
    throw new EditApiError("PROPOSAL_NOT_FOUND", `pending proposal ${JSON.stringify(proposal.id)} does not exist`, "$.id");
  }
  const merged = mergeReviewTransition(readProposalPath(pending, proposal.id), proposal);
  const path = proposalComplete(merged)
    ? archiveWithQa(projectFile, proposal.id, merged, readQaSidecar(projectFile, proposal.id, false))
    : persistMergedReview(projectFile, pending, merged);
  return { path, proposal: merged };
}

export function persistReviewedProposal(projectFile: string, value: unknown): string {
  const proposal = parseProposal(value);
  return withStorageLock(projectFile, proposal.id, () => persistReviewedProposalLocked(projectFile, proposal).path);
}

export interface AppliedProposalReview {
  path: string;
  proposal: EditProposal;
  projectChanged: boolean;
}

/** Apply newly accepted hunks to the latest on-disk document under a
 * byte-checked atomic write, then record their decisions. Re-running after a
 * crash is safe: already-applied hunks skip the project write and finish the
 * sidecar transition. */
export function applyAcceptedProposalReview(projectFile: string, value: unknown): AppliedProposalReview {
  const proposal = parseProposal(value);
  const target = realpathSync(resolve(projectFile));
  return withProjectFileLock(target, () => withStorageLock(projectFile, proposal.id, () => {
    const pending = proposalPath(projectFile, proposal.id);
    if (!existsSync(pending)) {
      throw new EditApiError("PROPOSAL_NOT_FOUND", `pending proposal ${JSON.stringify(proposal.id)} does not exist`, "$.id");
    }
    const previous = readProposalPath(pending, proposal.id);
    const storedQa = readQaSidecar(projectFile, proposal.id, false);
    const merged = mergeReviewTransition(previous, proposal);
    const acceptedIds = merged.hunks.flatMap((hunk, index) =>
      previous.hunks[index]!.decision === undefined && hunk.decision?.status === "accepted" ? [hunk.id] : []);
    let projectChanged = false;
    let liveSource: string | undefined;
    let output: string | undefined;
    let qa: QaReport | null = null;
    const clean: string[] = [];
    const publishedAssets: PublishedProposalAsset[] = [];
    const createdAssetDirectories: string[] = [];
    let projectWritten = false;
    if (acceptedIds.length > 0) {
      liveSource = readFileSync(target, "utf8");
      const project = projectFromSource(liveSource);
      const assetData = assetLookupFor(target);
      for (const id of acceptedIds) {
        const hunk = merged.hunks.find((candidate) => candidate.id === id)!;
        const assessment = assessHunk(project, hunk, assetData);
        if (assessment.state === "clean") clean.push(id);
        else if (assessment.state !== "already-applied") {
          throw new ProposalError(
            "PROPOSAL_HUNK_CONFLICT",
            `accepted hunk ${JSON.stringify(id)} is ${assessment.state} in the host project`,
            `$.hunks.${id}`,
            "clean or already-applied",
            assessment.state,
            assessment.conflicts,
          );
        }
      }
      if (clean.length > 0) {
        const edited = applyProposalHunks(project, merged, clean, assetData);
        qa = qaWithStoredBaseline(qaReportFor(edited), storedQa, proposal.id, proposal.baseHash);
        assertQaAcceptable(proposal.id, proposal.baseHash, qa, storedQa);
        output = serializeProjectPreservingSource(liveSource, project, edited);
        if (proposalComplete(merged)) assertArchiveCompatible(projectFile, merged);
        projectChanged = true;
      } else {
        qa = qaWithStoredBaseline(qaReportFor(project), storedQa, proposal.id, proposal.baseHash);
        assertQaAcceptable(proposal.id, proposal.baseHash, qa, storedQa);
      }
    }
    try {
      if (clean.length > 0) {
        publishProposalAssets(target, merged, clean, publishedAssets, createdAssetDirectories);
        if (liveSource !== undefined && output !== undefined) {
          atomicWriteProjectFile(target, output, liveSource);
          projectWritten = true;
        }
      }
      const persisted = proposalComplete(merged)
        ? archiveWithQa(projectFile, proposal.id, merged, qa ?? storedQa)
        : persistMergedReview(projectFile, pending, merged);
      if (!proposalComplete(merged) && qa !== null) writeQaSidecar(projectFile, proposal.id, qa, false);
      return { path: persisted, proposal: merged, projectChanged };
    } catch (error) {
      if (projectChanged) {
        try {
          if (projectWritten && liveSource !== undefined && output !== undefined) atomicWriteProjectFile(target, liveSource, output);
          rollbackProposalAssets(publishedAssets, createdAssetDirectories);
        } catch (rollbackError) {
          throw new ProposalPartialWriteError(
            "PROPOSAL_PARTIAL_WRITE",
            `proposal review failed and its project/asset rollback could not be verified: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            target,
            undefined,
            undefined,
            { cause: error instanceof Error ? error.message : String(error) },
          );
        }
      }
      throw error;
    }
  }));
}

function failure(command: ProposalCommandName, file: string | undefined, dryRun: boolean, error: unknown): ProposalFileFailure {
  const known = error instanceof EditApiError || error instanceof ProposalError
    ? error
    : new EditApiError("PROPOSAL_IO_ERROR", error instanceof Error ? error.message : String(error));
  return {
    ok: false,
    command,
    ...(file === undefined ? {} : { file }),
    dryRun,
    written: error instanceof ProposalPartialWriteError,
    error: {
      code: known.code,
      message: known.message,
      ...(known.path === undefined ? {} : { path: known.path }),
      ...(known.expected === undefined ? {} : { expected: known.expected }),
      ...(known.actual === undefined ? {} : { actual: known.actual }),
      ...(known.details === undefined ? {} : { details: known.details }),
    },
  };
}

function qaForInlineProposal(source: string, proposal: EditProposal): QaReport {
  const base = projectFromSource(source);
  const after = applyProposalHunks(base, proposal, proposal.hunks.map((hunk) => hunk.id));
  return qaWithBaseline(qaReportFor(after), proposalQa(base), proposal.id, proposal.baseHash);
}

function assertQaAcceptable(id: string, baseHash: string, qa: QaReport, stored: QaReport | null): void {
  const introduced = qaNewErrors(qa, stored, id, baseHash);
  if (introduced.length === 0) return;
  throw new ProposalError(
    "PROPOSAL_QA_FAILED",
    `proposal ${JSON.stringify(id)} introduces ${introduced.length} QA error finding(s)`,
    "$.hunks",
    "no errors beyond the proposal creation baseline",
    introduced.length,
    introduced,
  );
}

function shardLoaderFor(file: string): (entry: string) => string {
  return (entry: string) => readFileSync(confinedProjectShardPath(file, entry), "utf8");
}

function optionalSource(value: unknown): string {
  if (value === undefined) return "cli";
  if (typeof value !== "string" || value.length === 0 || value.length > 160) {
    throw new EditApiError("INVALID_ARGUMENT", "source must be a string of 1-160 characters", "$.source", "string", value);
  }
  return value;
}

function success(
  command: ProposalCommandName,
  file: string,
  dryRun: boolean,
  written: boolean,
  result: unknown,
): ProposalFileSuccess {
  return { ok: true, command, file, proposalDirectory: proposalDirectoryFor(file), dryRun, written, result };
}

/** Write the proposal sidecar and its QA sidecar, then return the stored
 * proposal path. Both files land under one storage lock so a concurrent
 * reader never sees a proposal without its QA attachment. */
function writeProposalWithQa(file: string, proposal: EditProposal, qa: QaReport, dryRun: boolean): string {
  const path = proposalPath(file, proposal.id);
  const archived = proposalPath(file, proposal.id, true);
  if (dryRun) {
    if (existsSync(path) || existsSync(archived)) {
      throw new EditApiError("PROPOSAL_ALREADY_EXISTS", `proposal ${JSON.stringify(proposal.id)} already exists`, "$.id");
    }
    return path;
  }
  return withStorageLock(file, proposal.id, () => {
    if (existsSync(path) || existsSync(archived)) {
      throw new EditApiError("PROPOSAL_ALREADY_EXISTS", `proposal ${JSON.stringify(proposal.id)} already exists`, "$.id");
    }
    const qaPath = qaSidecarPath(file, proposal.id, false);
    // A crash after the first create leaves only an unreferenced file in qa/;
    // no old or new queue reader can mistake it for a proposal. A synchronous
    // failure removes it before returning.
    rmSync(qaPath, { force: true });
    atomicCreate(qaPath, `${JSON.stringify(qa, null, 2)}\n`);
    try {
      atomicCreate(path, `${JSON.stringify(proposal, null, 2)}\n`);
      return path;
    } catch (error) {
      rmSync(qaPath, { force: true });
      throw error;
    }
  });
}

function archiveWithQa(file: string, id: string, decided: EditProposal, qa: QaReport | null): string {
  const pending = proposalPath(file, id);
  const archived = proposalPath(file, id, true);
  assertArchiveCompatible(file, decided);
  const archiveQa = qaSidecarPath(file, id, true);
  if (qa !== null) {
    writeQaSidecar(file, id, qa, true);
  }
  let archivedPath: string;
  try {
    archivedPath = persistMergedReview(file, pending, decided);
  } catch (error) {
    if (!existsSync(archived)) rmSync(archiveQa, { force: true });
    throw error;
  }
  rmSync(qaSidecarPath(file, id, false), { force: true });
  rmSync(legacyQaSidecarPath(file, id, false), { force: true });
  return archivedPath;
}

function listArchive(file: string): unknown[] {
  const archive = proposalArchiveDirectoryFor(file);
  if (!existsSync(archive)) return [];
  assertStorageDirectory(file, false);
  const files = Array.from(new Bun.Glob("*.json").scanSync({ cwd: archive, onlyFiles: true }))
    .filter((name) => !name.endsWith(".qa.json") || existsSync(join(archive, "qa", name)))
    .sort();
  return files.map((name) => {
    const id = name.slice(0, -".json".length);
    const proposal = readProposalPath(join(archive, name), id);
    const qa = readQaSidecar(file, id, true);
    return {
      id: proposal.id,
      title: proposal.title,
      author: proposal.author,
      createdAt: proposal.createdAt,
      ...decisionOf(proposal),
      summary: diffSummary(proposal),
      ...(qa === null ? {} : { qa: qaSummary(qa) }),
    };
  });
}

function acceptInline(
  file: string,
  source: string,
  id: string,
  source2: string,
  dryRun: boolean,
  now: () => string,
): ProposalFileSuccess {
  const target = realpathSync(resolve(file));
  return withProjectFileLock(target, () => withStorageLock(file, id, () => {
    const pending = proposalPath(file, id);
    if (!existsSync(pending)) {
      throw new EditApiError("PROPOSAL_NOT_FOUND", `pending proposal ${JSON.stringify(id)} does not exist`, "$.id");
    }
    const previous = readProposalPath(pending, id);
    const storedQa = readQaSidecar(file, id, false);
    if (previous.hunks.some((hunk) => hunk.decision !== undefined)) {
      throw new EditApiError("PROPOSAL_ALREADY_DECIDED", `proposal ${JSON.stringify(id)} already has decisions; withdraw and recreate it to change the review`, "$.id");
    }
    const liveSource = readFileSync(target, "utf8");
    const project = projectFromSource(liveSource);
    const assetData = assetLookupFor(target);
    const assessment = assessProposal(project, previous, assetData);
    const blocked = assessment.hunks.filter((hunk) => hunk.state === "conflict" || hunk.state === "partially-applied");
    if (blocked.length > 0) {
      throw new ProposalError(
        "PROPOSAL_HUNK_CONFLICT",
        `proposal ${JSON.stringify(id)} has conflicting hunks and cannot be accepted`,
        "$.hunks",
        "clean or already-applied",
        blocked.map((hunk) => hunk.id),
        blocked,
      );
    }
    const cleanIds = assessment.hunks.filter((hunk) => hunk.state === "clean").map((hunk) => hunk.id);
    let edited = project;
    if (cleanIds.length > 0) edited = applyProposalHunks(project, previous, cleanIds, assetData);
    const qa = qaWithStoredBaseline(qaReportFor(edited, now), storedQa, previous.id, previous.baseHash);
    assertQaAcceptable(id, previous.baseHash, qa, storedQa);
    const projectChanged = cleanIds.length > 0;
    const decided = decideProposalHunks(previous, previous.hunks.map((hunk) => hunk.id), "accepted", now(), source2);
    assertArchiveCompatible(file, decided);
    const output = projectChanged ? serializeProjectPreservingSource(liveSource, project, edited) : undefined;
    let archivedPath: string | undefined;
    let projectWritten = false;
    const publishedAssets: PublishedProposalAsset[] = [];
    const createdAssetDirectories: string[] = [];
    try {
      if (!dryRun) {
        publishProposalAssets(target, previous, cleanIds, publishedAssets, createdAssetDirectories);
        if (output !== undefined) {
          atomicWriteProjectFile(target, output, liveSource);
          projectWritten = true;
        }
      }
      archivedPath = dryRun ? undefined : archiveWithQa(file, id, decided, qa);
    } catch (error) {
      if (!dryRun) {
        try {
          if (projectWritten && output !== undefined) atomicWriteProjectFile(target, liveSource, output);
          rollbackProposalAssets(publishedAssets, createdAssetDirectories);
        } catch (rollbackError) {
          throw new ProposalPartialWriteError(
            "PROPOSAL_PARTIAL_WRITE",
            `accept failed and its project/asset rollback could not be verified: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            target,
            undefined,
            undefined,
            { cause: error instanceof Error ? error.message : String(error) },
          );
        }
      }
      throw error;
    }
    return success("accept-proposal", file, dryRun, !dryRun, {
      id,
      status: "accepted",
      ...(archivedPath === undefined ? {} : { archived: archivedPath }),
      projectChanged,
      appliedHunks: cleanIds,
      qa,
      publishedAssets: publishedAssets.map((asset) => relative(dirname(target), asset.path).split(process.platform === "win32" ? "\\" : "/").join("/")),
      summary: diffSummary(previous),
    });
  }));
}

function acceptOnShell(
  file: string,
  source: string,
  id: string,
  source2: string,
  dryRun: boolean,
  now: () => string,
): ProposalFileSuccess {
  const target = realpathSync(resolve(file));
  return withProjectFileLock(target, () => withStorageLock(file, id, () => {
    const pending = proposalPath(file, id);
    if (!existsSync(pending)) {
      throw new EditApiError("PROPOSAL_NOT_FOUND", `pending proposal ${JSON.stringify(id)} does not exist`, "$.id");
    }
    const previous = readProposalPath(pending, id);
    const storedQa = readQaSidecar(file, id, false);
    if (previous.hunks.some((hunk) => hunk.decision !== undefined)) {
      throw new EditApiError("PROPOSAL_ALREADY_DECIDED", `proposal ${JSON.stringify(id)} already has decisions; withdraw and recreate it to change the review`, "$.id");
    }
    const liveShellSource = readFileSync(target, "utf8");
    const assetData = assetLookupFor(target);
    const accepted = acceptShardedProposal(liveShellSource, shardLoaderFor(file), previous, storedQa, now, assetData);
    const decided = decideProposalHunks(previous, previous.hunks.map((hunk) => hunk.id), "accepted", now(), source2);
    assertArchiveCompatible(file, decided);
    const replacements: AtomicReplacement[] = [];
    if (accepted.changed) {
      for (const [entry, text] of Object.entries(accepted.shardTexts)) {
        const original = accepted.originalShardTexts[entry];
        replacements.push({
          path: original === undefined ? confinedProjectNewShardPath(file, entry) : confinedProjectShardPath(file, entry),
          text,
          expectedSource: original ?? null,
        });
      }
      // The manifest is the commit marker and must always be last.
      replacements.push({ path: target, text: accepted.shellText, expectedSource: liveShellSource });
    }
    let archivedPath: string | undefined;
    let projectFilesWritten = false;
    const publishedAssets: PublishedProposalAsset[] = [];
    const createdAssetDirectories: string[] = [];
    // A structural delete-map drops the mapIndex entry but leaves the shard
    // file on disk. Capture its bytes so the accept rollback can restore it,
    // then remove the orphan after the shell publishes so a same-named map
    // can be re-added.
    const removedShardFiles: { path: string; text: string }[] = [];
    if (!dryRun && accepted.changed) {
      for (const entry of accepted.removedEntries) {
        const path = confinedProjectShardPath(file, entry);
        try {
          removedShardFiles.push({ path, text: readFileSync(path, "utf8") });
        } catch {
          // Already absent; nothing to clean up or restore.
        }
      }
    }
    try {
      if (!dryRun) {
        publishProposalAssets(target, previous, accepted.appliedHunks, publishedAssets, createdAssetDirectories);
        if (replacements.length > 0) {
          atomicWriteProjectFiles(replacements);
          projectFilesWritten = true;
        }
        for (const removed of removedShardFiles) rmSync(removed.path, { force: true });
      }
      archivedPath = dryRun ? undefined : archiveWithQa(file, id, decided, accepted.qa);
    } catch (error) {
      if (!dryRun) {
        try {
          if (projectFilesWritten) {
            const created = replacements.filter((replacement) => replacement.expectedSource === null);
            for (const replacement of created) {
              if (readFileSync(replacement.path, "utf8") !== replacement.text) {
                throw new Error(`created shard changed before rollback: ${replacement.path}`);
              }
              rmSync(replacement.path);
            }
            atomicWriteProjectFiles(replacements.filter((replacement) => replacement.expectedSource !== null).map((replacement) => ({
              path: replacement.path,
              text: replacement.expectedSource!,
              expectedSource: replacement.text,
            })));
            for (const removed of removedShardFiles) writeFileSync(removed.path, removed.text, "utf8");
          }
          rollbackProposalAssets(publishedAssets, createdAssetDirectories);
        } catch (rollbackError) {
          throw new ProposalPartialWriteError(
            "PROPOSAL_PARTIAL_WRITE",
            `accept failed and its shell/asset rollback could not be verified: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            target,
            undefined,
            undefined,
            { cause: error instanceof Error ? error.message : String(error) },
          );
        }
      }
      throw error;
    }
    return success("accept-proposal", file, dryRun, !dryRun, {
      id,
      status: "accepted",
      ...(archivedPath === undefined ? {} : { archived: archivedPath }),
      projectChanged: accepted.changed || accepted.appliedHunks.some((hunkId) =>
        Object.keys(previous.hunks.find((hunk) => hunk.id === hunkId)?.assets ?? {}).length > 0),
      appliedHunks: accepted.appliedHunks,
      touchedEntries: shardEntriesForProposal(previous),
      qa: accepted.qa,
      publishedAssets: publishedAssets.map((asset) => relative(dirname(target), asset.path).split(process.platform === "win32" ? "\\" : "/").join("/")),
      summary: diffSummary(previous),
    });
  }));
}

function rejectAny(file: string, id: string, source2: string, dryRun: boolean, now: () => string): ProposalFileSuccess {
  return withStorageLock(file, id, () => {
    const pending = proposalPath(file, id);
    if (!existsSync(pending)) {
      throw new EditApiError("PROPOSAL_NOT_FOUND", `pending proposal ${JSON.stringify(id)} does not exist`, "$.id");
    }
    const previous = readProposalPath(pending, id);
    if (previous.hunks.some((hunk) => hunk.decision !== undefined)) {
      throw new EditApiError("PROPOSAL_ALREADY_DECIDED", `proposal ${JSON.stringify(id)} already has decisions; withdraw and recreate it to change the review`, "$.id");
    }
    const decided = decideProposalHunks(previous, previous.hunks.map((hunk) => hunk.id), "rejected", now(), source2);
    const archivedPath = dryRun ? undefined : archiveWithQa(file, id, decided, readQaSidecar(file, id, false));
    return success("reject-proposal", file, dryRun, !dryRun, {
      id,
      status: "rejected",
      ...(archivedPath === undefined ? {} : { archived: archivedPath }),
      summary: diffSummary(previous),
    });
  });
}

export function runProposalFileCommand(request: ProposalFileRequest): ProposalFileResponse {
  let file: string | undefined;
  const dryRun = request.dryRun === true;
  const now = () => new Date().toISOString();
  try {
    file = resolveProjectFile(request.file, request.root);
    const projectFile = file;
    const directory = proposalDirectoryFor(file);
    assertStorageDirectory(file, false);
    const source = readFileSync(file, "utf8");
    const shell = sourceDeclaresProjectShell(source);

    if (request.command === "propose") {
      if (shell) {
        const proposalRequest = requestFrom(request.args, now);
        const dryRunResult = dryRunShardedProposal(source, shardLoaderFor(file), proposalRequest, now);
        const qa = qaForShardedProposalWithBaseline(
          dryRunResult.beforeShell,
          dryRunResult.beforeShards,
          dryRunResult.afterShell,
          dryRunResult.afterShards,
          shardLoaderFor(file),
          dryRunResult.proposal.id,
          dryRunResult.proposal.baseHash,
          now,
        );
        const path = writeProposalWithQa(file, dryRunResult.proposal, qa, dryRun);
        return success("propose", file, dryRun, !dryRun, {
          path,
          proposal: dryRunResult.proposal,
          qa,
          touchedEntries: dryRunResult.touchedEntries,
        });
      }
      const proposal = createProposalFromOperations(source, request.args, now);
      const qa = qaForInlineProposal(source, proposal);
      const path = writeProposalWithQa(file, proposal, qa, dryRun);
      return success("propose", file, dryRun, !dryRun, { path, proposal, qa });
    }

    const args = record(request.args ?? {}, "$");
    const allowed = request.command === "list-proposals" || request.command === "list-archive"
      ? []
      : request.command === "accept-proposal" || request.command === "reject-proposal"
        ? ["id", "source"]
        : ["id"];
    const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw new EditApiError("INVALID_ARGUMENT", `unknown argument(s): ${unknown.join(", ")}`, "$", allowed, unknown);

    if (request.command === "list-archive") {
      return success("list-archive", file, dryRun, false, listArchive(file));
    }

    if (request.command === "list-proposals") {
      const loader = shell ? shardLoaderFor(file) : null;
      const project = shell ? null : projectFromSource(source);
      const assetData = assetLookupFor(file);
      const proposals = loadPendingProposals(file).map((proposal) => ({
        id: proposal.id,
        title: proposal.title,
        author: proposal.author,
        createdAt: proposal.createdAt,
        hunkCount: proposal.hunks.length,
        pendingHunks: proposal.hunks.filter((hunk) => hunk.decision === undefined).length,
        assessment: shell
          ? assessShardedProposal(source, loader!, proposal, assetData)
          : assessProposal(project!, proposal, assetData),
        ...(() => {
          const qa = readQaSidecar(projectFile, proposal.id, false);
          return qa === null ? {} : { qa: qaSummary(qa) };
        })(),
      }));
      return success("list-proposals", file, dryRun, false, proposals);
    }

    const id = safeId(args.id);
    const pending = proposalPath(file, id);
    const archived = proposalPath(file, id, true);

    if (request.command === "show-proposal") {
      const path = existsSync(pending) ? pending : archived;
      if (!existsSync(path)) throw new EditApiError("PROPOSAL_NOT_FOUND", `proposal ${JSON.stringify(id)} does not exist`, "$.id");
      const proposal = readProposalPath(path, id);
      const isArchived = path === archived;
      const assetData = assetLookupFor(file);
      const assessment = shell
        ? assessShardedProposal(source, shardLoaderFor(file), proposal, assetData)
        : assessProposal(projectFromSource(source), proposal, assetData);
      return success("show-proposal", file, dryRun, false, {
        path,
        archived: isArchived,
        proposal,
        assessment,
        qa: readQaSidecar(file, id, isArchived),
      });
    }

    if (request.command === "accept-proposal") {
      const source2 = optionalSource(args.source);
      return shell ? acceptOnShell(file, source, id, source2, dryRun, now) : acceptInline(file, source, id, source2, dryRun, now);
    }

    if (request.command === "reject-proposal") {
      return rejectAny(file, id, optionalSource(args.source), dryRun, now);
    }

    if (!existsSync(pending)) throw new EditApiError("PROPOSAL_NOT_FOUND", `pending proposal ${JSON.stringify(id)} does not exist`, "$.id");
    if (lstatSync(pending).isSymbolicLink()) throw new EditApiError("UNSAFE_PROPOSAL_PATH", "proposal files may not be symbolic links", pending);
    readProposalPath(pending, id);
    if (!dryRun) withStorageLock(file, id, () => {
      if (!existsSync(pending)) throw new EditApiError("PROPOSAL_NOT_FOUND", `pending proposal ${JSON.stringify(id)} does not exist`, "$.id");
      readProposalPath(pending, id);
      rmSync(pending);
      rmSync(qaSidecarPath(file!, id, false), { force: true });
      rmSync(legacyQaSidecarPath(file!, id, false), { force: true });
    });
    return success("withdraw-proposal", file, dryRun, !dryRun, { id, withdrawn: true });
  } catch (error) {
    return failure(request.command, file ?? request.file, dryRun, error);
  }
}
