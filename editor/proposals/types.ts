import type { EditChange } from "../api/types.ts";

export const PROPOSAL_SESSION_PATH = "proposal-session.json";
export const PROPOSAL_HOST_STATE_PATH = "proposal-host-state.json";
export const EDITOR_SAVE_CAPABILITY_PATH = "editor-save-capability.json";
export const EDITOR_SAVE_REQUEST_PATH = "editor-save-request.json";
export const EDITOR_SAVE_RESULT_PATH = "editor-save-result.json";
export const EDITOR_SAVE_PROTOCOL = "rpgkit-editor-save-cas/v1";

export type ProposalDecisionStatus = "accepted" | "rejected";

export interface ProposalDecision {
  status: ProposalDecisionStatus;
  decidedAt: string;
  /** Who made the decision (CLI/MCP surface, agent id, …). Omitted by
   * reviews written before this field existed. */
  source?: string;
}

export interface ProposalHunk {
  id: string;
  summary: string;
  changes: EditChange[];
  /** Proposal-owned PNGs, keyed by the project-relative path referenced by
   * sprite declarations. Assets are immutable additions: acceptance never
   * overwrites differing existing bytes. */
  assets?: Record<string, ProposalAsset>;
  /** Omitted while the hunk is waiting for review. */
  decision?: ProposalDecision;
}

export interface ProposalAsset {
  type: "image/png";
  data: string;
}

/** Stored wire format. The seven required fields deliberately match the
 * public AI3 proposal contract; review metadata lives only on each hunk. */
export interface EditProposal {
  id: string;
  title: string;
  rationale: string;
  author: string;
  createdAt: string;
  baseHash: string;
  hunks: ProposalHunk[];
}

export interface ProposedOperation {
  command: string;
  args?: Record<string, unknown>;
}

export interface ProposalHunkRequest {
  id: string;
  summary: string;
  operations: ProposedOperation[];
}

export interface ProposalRequest {
  id: string;
  title: string;
  rationale: string;
  author: string;
  createdAt?: string;
  hunks: ProposalHunkRequest[];
}

export type HunkApplyState = "clean" | "already-applied" | "partially-applied" | "conflict";

export interface HunkAssessment {
  id: string;
  state: HunkApplyState;
  conflicts: string[];
}

export interface ProposalAssessment {
  baseMatches: boolean;
  hasConflicts: boolean;
  hunks: HunkAssessment[];
}

export interface ProposalTilePreview {
  mapId: string;
  layer: "ground" | "upper";
  x: number;
  y: number;
  tile: string | null;
}

export interface ProposalEventPreview {
  mapId: string;
  kind: "added" | "deleted" | "moved" | "changed";
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fromX?: number;
  fromY?: number;
}

export interface ProposalMapPreview {
  /** The live map id, retained when the proposal also renames the map. */
  mapId: string;
  width: number;
  height: number;
}

export interface ProposalPreview {
  tiles: ProposalTilePreview[];
  events: ProposalEventPreview[];
  maps: ProposalMapPreview[];
}

export interface ProposalSession {
  projectHash: string;
  proposals: EditProposal[];
}

/** Written only by the desktop bridge. Keeping this separate from the
 * guest-written review session makes it a trustworthy observation of the
 * project file revision for SAVE conflict checks. */
export interface ProposalHostState {
  projectHash: string;
}

/** Guest-to-launcher save request. The launcher compares the exact source
 * revision while holding the same lock as CLI edits and proposal acceptance. */
export interface EditorSaveRequest {
  id: string;
  expectedSourceHash: string;
  projectHash: string;
  text: string;
}

export interface EditorSaveResult {
  id: string;
  status: "saved" | "conflict" | "invalid";
  projectHash: string;
  message?: string;
}
