// editor/api/file.ts — synchronous staged file adapter shared by CLI + MCP.

import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { executeEditOperation } from "./operations.ts";
import {
  executeShardedEditOperation,
  executeShardedEditTransaction,
  loadValidatedProjectShell,
  shardEntriesForOperation,
  sourceDeclaresProjectShell,
} from "./sharded.ts";
import type { EditResponse, FileEditResponse } from "./types.ts";
import { FileLockBusyError, withFileLock } from "./lock.ts";

export interface FileEditRequest {
  command: string;
  file: string;
  args?: unknown;
  dryRun?: boolean;
  /** Optional MCP safety boundary. Symlinks are resolved before this check. */
  root?: string;
}

function ioFailure(
  command: string,
  file: string,
  dryRun: boolean,
  code: "READ_FAILED" | "WRITE_FAILED" | "WRITE_CONFLICT" | "PATH_OUTSIDE_ROOT",
  error: unknown,
): FileEditResponse {
  return {
    ok: false,
    command,
    file,
    dryRun,
    written: false,
    error: {
      code,
      message: `${code === "READ_FAILED" ? "could not read" : code === "PATH_OUTSIDE_ROOT" ? "path is outside the configured project root" : code === "WRITE_CONFLICT" ? "file changed before it could be saved" : "could not publish"} ${file}: ${error instanceof Error ? error.message : String(error)}`,
      path: file,
    },
  };
}

export class WriteConflictError extends Error {}

export interface AtomicReplacement {
  path: string;
  text: string;
  /** Exact current bytes, or null when this transaction creates the file. */
  expectedSource: string | null;
}

interface StagedReplacement extends AtomicReplacement {
  temporary: string;
  mode: number;
}

export function projectFileLockPath(path: string): string {
  return `${path}.rpgkit-edit.lock`;
}

/** Serialize cooperating direct edits and proposal acceptance across the
 * complete compare-and-replace window. */
export function withProjectFileLock<T>(path: string, run: () => T): T {
  try {
    return withFileLock(projectFileLockPath(path), run);
  } catch (error) {
    if (error instanceof FileLockBusyError) {
      throw new WriteConflictError("another writer currently owns the project file lock");
    }
    throw error;
  }
}

/** Stage every output, recheck every input, then publish in caller order.
 * ProjectShell callers order shards first and the shell last. Best-effort
 * rollback restores already-published bytes if a later rename fails. The
 * caller must hold the project-shell lock for multi-file replacements. */
function atomicWriteMany(replacements: readonly AtomicReplacement[]): void {
  const staged: StagedReplacement[] = [];
  const committed: StagedReplacement[] = [];
  try {
    if (new Set(replacements.map((replacement) => replacement.path)).size !== replacements.length) {
      throw new Error("atomic replacement targets must be unique");
    }
    for (const replacement of replacements) {
      const mode = replacement.expectedSource === null ? 0o600 : statSync(replacement.path).mode;
      const temporary = `${replacement.path}.rpgkit-edit-${process.pid}-${randomUUID()}.tmp`;
      writeFileSync(temporary, replacement.text, { encoding: "utf8", flag: "wx", mode });
      staged.push({ ...replacement, temporary, mode });
      chmodSync(temporary, mode);
    }
    for (const replacement of staged) {
      if (replacement.expectedSource === null ? existsSync(replacement.path) :
          readFileSync(replacement.path, "utf8") !== replacement.expectedSource) {
        throw new WriteConflictError(`on-disk bytes no longer match the edited revision: ${replacement.path}`);
      }
    }
    for (const replacement of staged) {
      renameSync(replacement.temporary, replacement.path);
      committed.push(replacement);
    }
  } catch (error) {
    // A failure before the shell replacement leaves the old manifest live.
    // Restore any shards already published so subsequent reads are coherent.
    for (const replacement of [...committed].reverse()) {
      if (replacement.expectedSource === null) {
        rmSync(replacement.path, { force: true });
        continue;
      }
      const rollback = `${replacement.path}.rpgkit-edit-${process.pid}-${randomUUID()}.rollback`;
      try {
        writeFileSync(rollback, replacement.expectedSource, {
          encoding: "utf8",
          flag: "wx",
          mode: replacement.mode,
        });
        chmodSync(rollback, replacement.mode);
        renameSync(rollback, replacement.path);
      } catch {
        rmSync(rollback, { force: true });
      }
    }
    for (const replacement of staged) rmSync(replacement.temporary, { force: true });
    throw error;
  }
}

/** Replace several files of one project with atomicWriteMany's guarantees:
 * every output staged first, every input rechecked, published in the given
 * order (shards first, the shell last), already-published files restored if a
 * later rename fails. Desktop hosts saving a project folder in place call it
 * under withProjectFileLock(shell), the lock the CLI and MCP server take. */
export function atomicWriteProjectFiles(replacements: readonly AtomicReplacement[]): void {
  atomicWriteMany(replacements);
}

/** Atomically replace one project file only while its source bytes still
 * match the revision the caller read. Shared by direct edits and proposal
 * acceptance so neither path can silently overwrite a newer revision. */
export function atomicWriteProjectFile(path: string, text: string, expectedSource: string): void {
  atomicWriteMany([{ path, text, expectedSource }]);
}

function outside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot);
}

/** Symlink-safe root confinement for a path that may not exist yet (a fresh
 *  output file): the deepest existing ancestor is realpath'ed, so a symlink
 *  pointing out of the root is caught even when the leaf is missing. The
 *  root itself is realpath'ed too. Returns the resolved absolute path, or
 *  null when the root does not exist or the path escapes it. */
export function confineWithinRoot(root: string, path: string): string | null {
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    return null;
  }
  let existing = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const resolved = join(realpathSync(existing), ...tail);
      return outside(rootReal, resolved) ? null : resolved;
    } catch {
      const base = basename(existing);
      const parent = dirname(existing);
      if (parent === existing) return null;
      tail.unshift(base);
      existing = parent;
    }
  }
}

/** Resolve a mapIndex entry to a real path confined under the shell's
 *  directory (or an explicit root). Shared by the sharded edit path and the
 *  materialize command. */
export function confinedShardPath(shellFile: string, root: string, entry: string): string {
  // mapIndex entries are portable package-style relative paths. Refuse both
  // platform separators for traversal, even when one is not special here.
  if (isAbsolute(entry) || entry.split(/[\\/]+/).some((part) => part === "..")) {
    throw new Error(`shard entry ${JSON.stringify(entry)} is not a confined relative path`);
  }
  const path = realpathSync(resolve(dirname(shellFile), entry));
  if (outside(root, path)) throw new Error(`shard entry ${JSON.stringify(entry)} resolves outside ${root}`);
  if (path === shellFile) throw new Error(`shard entry ${JSON.stringify(entry)} resolves to the project shell`);
  return path;
}

/** Resolve a mapIndex entry relative to a shell file, refusing absolute
 * paths, traversal, escapes from the shell's directory, and the shell file
 * itself. Shared by direct edits and proposal acceptance so both load shards
 * through the same confinement check. */
export function confinedProjectShardPath(shellFile: string, entry: string): string {
  return confinedShardPath(shellFile, dirname(shellFile), entry);
}

/** Resolve a proposed new map entry without requiring its leaf to exist. The
 * existing parent is realpath-checked, and an existing leaf is resolved too,
 * so neither a symlinked directory nor a last-component symlink can escape. */
export function confinedProjectNewShardPath(shellFile: string, entry: string): string {
  const root = dirname(shellFile);
  if (isAbsolute(entry) || entry.split(/[\\/]+/).some((part) => part === "..")) {
    throw new Error(`shard entry ${JSON.stringify(entry)} is not a confined relative path`);
  }
  const candidate = resolve(root, entry);
  const parent = realpathSync(dirname(candidate));
  if (outside(root, parent)) throw new Error(`shard entry ${JSON.stringify(entry)} resolves outside ${root}`);
  if (existsSync(candidate)) {
    const existing = realpathSync(candidate);
    if (outside(root, existing)) throw new Error(`shard entry ${JSON.stringify(entry)} resolves outside ${root}`);
    return existing;
  }
  return candidate;
}

function fileResponse(
  response: EditResponse,
  file: string,
  dryRun: boolean,
  written = false,
  writtenFiles?: string[],
): FileEditResponse {
  return {
    ...response,
    file,
    dryRun,
    written,
    ...(writtenFiles === undefined ? {} : { writtenFiles }),
  } as FileEditResponse;
}

/** Run a `batch` transaction against a ProjectShell: each operation's shards
 * are loaded lazily through the confinement check, the whole batch validates
 * as one unit, and only the changed shards plus the shell are published,
 * shards first and the manifest last. */
function runShellBatchEdit(
  request: FileEditRequest,
  file: string,
  dryRun: boolean,
  configuredRoot: string | undefined,
  shell: ReturnType<typeof loadValidatedProjectShell>,
  source: string,
): FileEditResponse {
  const boundary = configuredRoot ?? dirname(file);
  const paths = new Map<string, string>();
  const originals = Object.create(null) as Record<string, string>;
  const loadShard = (entry: string): string => {
    const cached = originals[entry];
    if (cached !== undefined) return cached;
    const path = confinedShardPath(file, boundary, entry);
    const text = readFileSync(path, "utf8");
    paths.set(entry, path);
    originals[entry] = text;
    return text;
  };
  let execution: ReturnType<typeof executeShardedEditTransaction>;
  try {
    execution = executeShardedEditTransaction(source, loadShard, request.args);
  } catch (error) {
    const pathFailure = error instanceof Error &&
      (/outside|confined relative path|project shell/.test(error.message));
    return ioFailure(
      request.command,
      file,
      dryRun,
      pathFailure ? "PATH_OUTSIDE_ROOT" : "READ_FAILED",
      error,
    );
  }
  if (!execution.response.ok) return fileResponse(execution.response, file, dryRun);
  if (dryRun || !execution.response.changed || execution.output === undefined) {
    return fileResponse(execution.response, file, dryRun);
  }
  const replacements: AtomicReplacement[] = [];
  try {
    for (const [entry, text] of Object.entries(execution.output.shards)) {
      const path = paths.get(entry);
      const expected = originals[entry];
      if (path === undefined || expected === undefined) {
        throw new Error(`batch emitted an unloaded shard ${JSON.stringify(entry)}`);
      }
      replacements.push({ path, text, expectedSource: expected });
    }
    // The manifest is the commit marker and must always be last.
    replacements.push({ path: file, text: execution.output.shell, expectedSource: source });
    withProjectFileLock(file, () => atomicWriteMany(replacements));
  } catch (error) {
    return ioFailure(
      request.command,
      file,
      dryRun,
      error instanceof WriteConflictError ? "WRITE_CONFLICT" : "WRITE_FAILED",
      error,
    );
  }
  return fileResponse(execution.response, file, dryRun, true, replacements.map((item) => item.path));
}

/** Read, execute, and (for effective mutations) atomically replace a file.
 * Dry-run follows the exact validation/diff path but never reaches the write. */
export function runFileEdit(request: FileEditRequest): FileEditResponse {
  const requestedFile = resolve(request.file);
  const dryRun = request.dryRun === true;
  let file: string;
  let source: string;
  let configuredRoot: string | undefined;
  try {
    // Resolve the final component before replacement so editing a symlink
    // updates its target rather than silently replacing the link itself.
    file = realpathSync(requestedFile);
    if (request.root !== undefined) {
      configuredRoot = realpathSync(resolve(request.root));
      if (outside(configuredRoot, file)) {
        return ioFailure(request.command, file, dryRun, "PATH_OUTSIDE_ROOT", new Error(`configured root is ${configuredRoot}`));
      }
    }
    source = readFileSync(file, "utf8");
  } catch (error) {
    return ioFailure(request.command, requestedFile, dryRun, "READ_FAILED", error);
  }

  if (sourceDeclaresProjectShell(source)) {
    let shell: ReturnType<typeof loadValidatedProjectShell>;
    try {
      shell = loadValidatedProjectShell(source);
    } catch {
      const execution = executeShardedEditOperation(source, {}, request.command, request.args);
      return fileResponse(execution.response, file, dryRun);
    }

    // A batch loads each operation's shards lazily (the set depends on the
    // evolving shell), so it cannot use the single-operation pre-load below.
    if (request.command === "batch") {
      return runShellBatchEdit(request, file, dryRun, configuredRoot, shell, source);
    }

    let entries: string[];
    try {
      entries = shardEntriesForOperation(shell, request.command, request.args);
    } catch {
      const execution = executeShardedEditOperation(source, {}, request.command, request.args);
      return fileResponse(execution.response, file, dryRun);
    }

    const boundary = configuredRoot ?? dirname(file);
    const paths = new Map<string, string>();
    const sources = Object.create(null) as Record<string, string>;
    try {
      for (const entry of entries) {
        const path = confinedShardPath(file, boundary, entry);
        paths.set(entry, path);
        sources[entry] = readFileSync(path, "utf8");
      }
    } catch (error) {
      const pathFailure = error instanceof Error &&
        (/outside|confined relative path|project shell/.test(error.message));
      return ioFailure(
        request.command,
        file,
        dryRun,
        pathFailure ? "PATH_OUTSIDE_ROOT" : "READ_FAILED",
        error,
      );
    }

    const execution = executeShardedEditOperation(source, sources, request.command, request.args);
    if (!execution.response.ok) return fileResponse(execution.response, file, dryRun);
    if (dryRun || !execution.response.changed || execution.output === undefined) {
      return fileResponse(execution.response, file, dryRun);
    }

    const replacements: AtomicReplacement[] = [];
    try {
      for (const [entry, text] of Object.entries(execution.output.shards)) {
        const path = paths.get(entry);
        if (path === undefined || sources[entry] === undefined) {
          throw new Error(`operation emitted an unloaded shard ${JSON.stringify(entry)}`);
        }
        replacements.push({ path, text, expectedSource: sources[entry] });
      }
      // The manifest is the commit marker and must always be last.
      replacements.push({ path: file, text: execution.output.shell, expectedSource: source });
      withProjectFileLock(file, () => atomicWriteMany(replacements));
    } catch (error) {
      return ioFailure(
        request.command,
        file,
        dryRun,
        error instanceof WriteConflictError ? "WRITE_CONFLICT" : "WRITE_FAILED",
        error,
      );
    }
    return fileResponse(execution.response, file, dryRun, true, replacements.map((item) => item.path));
  }

  const execution = executeEditOperation(source, request.command, request.args);
  if (!execution.response.ok) {
    return { ...execution.response, file, dryRun, written: false };
  }

  let written = false;
  if (!dryRun && execution.response.changed && execution.output !== undefined) {
    try {
      withProjectFileLock(file, () => atomicWriteProjectFile(file, execution.output!, source));
      written = true;
    } catch (error) {
      return ioFailure(
        request.command,
        file,
        dryRun,
        error instanceof WriteConflictError ? "WRITE_CONFLICT" : "WRITE_FAILED",
        error,
      );
    }
  }
  return { ...execution.response, file, dryRun, written };
}
