// Host-side bridge between project-adjacent proposal JSON and the editor's
// sandboxed data.fs snapshot. The desktop launcher polls this while the
// window is open so agents can observe review decisions without modifying
// PocketJS or granting the guest arbitrary host filesystem access.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  applyAcceptedProposalReview,
  loadPendingProposals,
  persistReviewedProposal,
  proposalArchiveDirectoryFor,
} from "../../editor/api/proposals.ts";
import {
  atomicWriteProjectFile,
  withProjectFileLock,
} from "../../editor/api/file.ts";
import {
  parseProposal,
  proposalSemanticHash,
} from "../../editor/proposals/model.ts";
import { loadProject } from "../../editor/engine/document.ts";
import { sha256Text } from "../../src/engine/map-repository.ts";
import {
  EDITOR_SAVE_CAPABILITY_PATH,
  EDITOR_SAVE_PROTOCOL,
  EDITOR_SAVE_REQUEST_PATH,
  EDITOR_SAVE_RESULT_PATH,
  PROPOSAL_HOST_STATE_PATH,
  PROPOSAL_SESSION_PATH,
  type EditorSaveRequest,
  type EditorSaveResult,
  type EditProposal,
  type ProposalSession,
} from "../../editor/proposals/types.ts";
import type { Project } from "../../src/engine/types.ts";

export interface EditorProposalBridgePaths {
  dataRoot: string;
  sessionFile: string;
  hostStateFile: string;
  saveCapabilityFile: string;
  saveRequestFile: string;
  saveResultFile: string;
}

export interface EditorProposalBridgeResult {
  pending: number;
  persisted: number;
  archived: number;
  wroteSession: boolean;
  waitingForProject: boolean;
  conflicts: string[];
  saveStatus: "idle" | EditorSaveResult["status"];
}

/** Give each host document an isolated data.fs base while retaining it across
 * launches. Only a short hash of the absolute path enters the directory. */
export function editorProposalBridgePaths(
  repoRoot: string,
  appId: string,
  projectFile: string,
): EditorProposalBridgePaths {
  const key = createHash("sha256").update(resolve(projectFile)).digest("hex").slice(0, 16);
  const dataRoot = join(repoRoot, ".pocket", "editor-data", key);
  return {
    dataRoot,
    sessionFile: join(dataRoot, appId, "data", PROPOSAL_SESSION_PATH),
    hostStateFile: join(dataRoot, appId, "data", PROPOSAL_HOST_STATE_PATH),
    saveCapabilityFile: join(dataRoot, appId, "data", EDITOR_SAVE_CAPABILITY_PATH),
    saveRequestFile: join(dataRoot, appId, "data", EDITOR_SAVE_REQUEST_PATH),
    saveResultFile: join(dataRoot, appId, "data", EDITOR_SAVE_RESULT_PATH),
  };
}

function parseSession(text: string): ProposalSession {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (typeof value.projectHash !== "string" || !/^[0-9a-f]{64}$/.test(value.projectHash) || !Array.isArray(value.proposals)) {
    throw new Error("invalid editor proposal session");
  }
  return {
    projectHash: value.projectHash,
    proposals: value.proposals.map(parseProposal),
  };
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function decisionsDiffer(a: EditProposal, b: EditProposal): boolean {
  if (a.hunks.length !== b.hunks.length) return true;
  return a.hunks.some((hunk, index) =>
    hunk.id !== b.hunks[index]?.id || JSON.stringify(hunk.decision) !== JSON.stringify(b.hunks[index]?.decision));
}

function newDecisionIds(
  stored: EditProposal,
  incoming: EditProposal,
  status: "accepted" | "rejected",
): string[] {
  return incoming.hunks.flatMap((hunk, index) =>
    stored.hunks[index]?.decision === undefined && hunk.decision?.status === status ? [hunk.id] : []);
}

function withoutNewAcceptances(stored: EditProposal, incoming: EditProposal): EditProposal {
  const next = structuredClone(incoming);
  for (let index = 0; index < next.hunks.length; index++) {
    if (stored.hunks[index]?.decision === undefined && next.hunks[index]?.decision?.status === "accepted") {
      delete next.hunks[index]!.decision;
    }
  }
  return parseProposal(next);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

const SHA256 = /^[0-9a-f]{64}$/;

function parseSaveRequest(text: string): EditorSaveRequest {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (!SHA256.test(String(value.id)) || !SHA256.test(String(value.expectedSourceHash)) ||
      !SHA256.test(String(value.projectHash)) || typeof value.text !== "string") {
    throw new Error("invalid editor save request");
  }
  return value as unknown as EditorSaveRequest;
}

function parseSaveResult(text: string): EditorSaveResult | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!SHA256.test(String(value.id)) ||
        !["saved", "conflict", "invalid"].includes(String(value.status)) ||
        !SHA256.test(String(value.projectHash))) return null;
    return value as unknown as EditorSaveResult;
  } catch {
    return null;
  }
}

/** Apply one guest save as a compare-and-swap under the project-file lock.
 * The stock desktop host never sees a {t:"save"} line in this managed path. */
function syncEditorSaveRequest(
  projectFile: string,
  requestFile: string,
  resultFile: string,
  hostStateFile: string,
): "idle" | EditorSaveResult["status"] {
  if (!existsSync(requestFile)) return "idle";
  const request = parseSaveRequest(readFileSync(requestFile, "utf8"));
  const previous = existsSync(resultFile) ? parseSaveResult(readFileSync(resultFile, "utf8")) : null;
  if (previous?.id === request.id) return "idle";

  const target = realpathSync(resolve(projectFile));
  return withProjectFileLock(target, () => {
    const source = readFileSync(target, "utf8");
    const current = loadProject(source);
    if (current.errors.length > 0) throw new Error(`host project is invalid: ${current.errors[0]!.path} ${current.errors[0]!.msg}`);
    let result: EditorSaveResult;
    const sourceHash = sha256Text(source);
    if (sourceHash === sha256Text(request.text) && proposalSemanticHash(current.project) === request.projectHash) {
      // Retry after a crash between the project rename and result-file write.
      result = { id: request.id, status: "saved", projectHash: request.projectHash };
    } else if (sourceHash !== request.expectedSourceHash) {
      result = {
        id: request.id,
        status: "conflict",
        projectHash: proposalSemanticHash(current.project),
        message: "host file changed since the editor loaded its save baseline",
      };
    } else {
      const candidate = loadProject(request.text);
      if (candidate.errors.length > 0 || proposalSemanticHash(candidate.project) !== request.projectHash) {
        result = {
          id: request.id,
          status: "invalid",
          projectHash: proposalSemanticHash(current.project),
          message: candidate.errors.length > 0
            ? `save candidate is invalid: ${candidate.errors[0]!.path} ${candidate.errors[0]!.msg}`
            : "save candidate semantic hash does not match its request",
        };
      } else {
        atomicWriteProjectFile(target, request.text, source);
        result = { id: request.id, status: "saved", projectHash: request.projectHash };
      }
    }
    atomicWrite(hostStateFile, `${JSON.stringify({ projectHash: result.projectHash }, null, 2)}\n`);
    atomicWrite(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    return result.status;
  });
}

/** Reconcile one poll. New/withdrawn sidecars flow into the guest snapshot;
 * guest decisions flow back through the validated sidecar transition gate.
 * Rejections never depend on document saves. Accepted hunks are applied by
 * this host bridge to the latest on-disk project with a byte-checked atomic
 * write, preserving unrelated external edits and making crash retries safe. */
export function syncEditorProposalBridge(
  projectFile: string,
  sessionFile: string,
  hostStateFile = join(dirname(sessionFile), PROPOSAL_HOST_STATE_PATH),
): EditorProposalBridgeResult {
  // Publish the capability before touching user-controlled proposal/session
  // data. If later initialization fails, the guest fails closed instead of
  // falling back to the generic desktop host's unlocked save path.
  const capabilityFile = join(dirname(sessionFile), EDITOR_SAVE_CAPABILITY_PATH);
  const capabilityText = `${JSON.stringify({ protocol: EDITOR_SAVE_PROTOCOL }, null, 2)}\n`;
  if (!existsSync(capabilityFile) || readFileSync(capabilityFile, "utf8") !== capabilityText) {
    atomicWrite(capabilityFile, capabilityText);
  }
  let pending = loadPendingProposals(projectFile);
  let byId = new Map(pending.map((proposal) => [proposal.id, proposal]));
  const sessionText = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8") : null;
  const session = sessionText === null ? null : parseSession(sessionText);
  const changed = session?.proposals.filter((proposal) => {
    const stored = byId.get(proposal.id);
    return stored !== undefined && decisionsDiffer(stored, proposal);
  }) ?? [];

  const persistedIds = new Set<string>();
  const archivedIds = new Set<string>();
  const conflicts: string[] = [];
  for (const incoming of changed) {
    let stored = byId.get(incoming.id);
    if (!stored) continue;

    // A rejection is a review fact, not a project mutation. Persist it even
    // when the editor has unrelated unsaved work or an accepted peer hunk is
    // waiting/conflicting.
    if (newDecisionIds(stored, incoming, "rejected").length > 0) {
      const destination = persistReviewedProposal(projectFile, withoutNewAcceptances(stored, incoming));
      persistedIds.add(incoming.id);
      if (dirname(destination) === proposalArchiveDirectoryFor(projectFile)) archivedIds.add(incoming.id);
      pending = loadPendingProposals(projectFile);
      byId = new Map(pending.map((proposal) => [proposal.id, proposal]));
      stored = byId.get(incoming.id);
      if (!stored) continue;
    }

    if (newDecisionIds(stored, incoming, "accepted").length > 0) {
      try {
        const result = applyAcceptedProposalReview(projectFile, incoming);
        persistedIds.add(incoming.id);
        if (dirname(result.path) === proposalArchiveDirectoryFor(projectFile)) archivedIds.add(incoming.id);
      } catch (error) {
        if (errorCode(error) === "PROPOSAL_HUNK_CONFLICT" || errorCode(error) === "PROPOSAL_QA_FAILED") {
          conflicts.push(error instanceof Error ? error.message : String(error));
          continue;
        }
        throw error;
      }
      pending = loadPendingProposals(projectFile);
      byId = new Map(pending.map((proposal) => [proposal.id, proposal]));
    }
  }

  const saveStatus = syncEditorSaveRequest(
    projectFile,
    join(dirname(sessionFile), EDITOR_SAVE_REQUEST_PATH),
    join(dirname(sessionFile), EDITOR_SAVE_RESULT_PATH),
    hostStateFile,
  );
  pending = loadPendingProposals(projectFile);
  const project = JSON.parse(readFileSync(projectFile, "utf8")) as Project;
  const projectHash = proposalSemanticHash(project);
  const next: ProposalSession = { projectHash, proposals: pending };
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  const wroteSession = sessionText !== nextText;
  if (wroteSession) atomicWrite(sessionFile, nextText);
  const hostStateText = `${JSON.stringify({ projectHash }, null, 2)}\n`;
  if (!existsSync(hostStateFile) || readFileSync(hostStateFile, "utf8") !== hostStateText) {
    atomicWrite(hostStateFile, hostStateText);
  }
  return {
    pending: pending.length,
    persisted: persistedIds.size,
    archived: archivedIds.size,
    wroteSession,
    waitingForProject: false,
    conflicts,
    saveStatus,
  };
}
