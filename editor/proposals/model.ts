// Pure proposal validation, conflict detection, application and preview.
// This module is shared by the Node CLI/MCP adapter and the PocketJS editor.

import type { GameEvent, JsonValue, MapDef, Project, TileId } from "../../src/engine/types.ts";
import { validateSchema, type VError } from "../../src/engine/schema-validate.ts";
import { validateMapDefStructure, sha256Text } from "../../src/engine/map-repository.ts";
import { canonicalJson } from "../../src/engine/save.ts";
import { deepClone } from "../../src/engine/clone.ts";
import { validateProject } from "../engine/document.ts";
import type { EditChange, PatchValue } from "../api/types.ts";
import { validatePngAssetRecord } from "../api/assets.ts";
import proposalSchema from "./schema.json";
import type {
  EditProposal,
  HunkAssessment,
  ProposalAssessment,
  ProposalDecisionStatus,
  ProposalEventPreview,
  ProposalMapPreview,
  ProposalPreview,
  ProposalTilePreview,
} from "./types.ts";

export class ProposalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
    readonly expected?: unknown,
    readonly actual?: unknown,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProposalError";
  }
}

export function proposalSemanticHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function pointerTokens(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/") || /~(?:[^01]|$)/.test(path.slice(1))) {
    throw new ProposalError("INVALID_PROPOSAL", `invalid JSON Pointer ${JSON.stringify(path)}`, path);
  }
  const tokens = path.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (tokens.some((token) => /^0\d+$/.test(token))) {
    throw new ProposalError("INVALID_PROPOSAL", `numeric JSON Pointer tokens must use canonical decimal form in ${JSON.stringify(path)}`, path);
  }
  return tokens;
}

function present(value: unknown): PatchValue {
  return { exists: true, value: deepClone(value) as JsonValue };
}

const ABSENT: PatchValue = { exists: false };

function sideAt(root: unknown, path: string): PatchValue {
  const tokens = pointerTokens(path);
  if (tokens.length === 0) return present(root);
  let cursor: unknown = root;
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index]!;
    if (Array.isArray(cursor)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token) || Number(token) >= cursor.length) return ABSENT;
      cursor = cursor[Number(token)];
    } else if (cursor !== null && typeof cursor === "object" && Object.hasOwn(cursor, token)) {
      cursor = (cursor as Record<string, unknown>)[token];
    } else return ABSENT;
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(cursor)) return /^(?:0|[1-9]\d*)$/.test(last) && Number(last) < cursor.length ? present(cursor[Number(last)]) : ABSENT;
  return cursor !== null && typeof cursor === "object" && Object.hasOwn(cursor, last)
    ? present((cursor as Record<string, unknown>)[last])
    : ABSENT;
}

function sameSide(a: PatchValue, b: PatchValue): boolean {
  return a.exists === b.exists && (!a.exists || (b.exists && canonicalJson(a.value) === canonicalJson(b.value)));
}

function setSide(root: unknown, path: string, side: PatchValue): unknown {
  const tokens = pointerTokens(path);
  if (tokens.length === 0) {
    if (!side.exists) throw new ProposalError("INVALID_PROPOSAL", "proposal cannot remove the document root", path);
    return deepClone(side.value);
  }
  let cursor = root;
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index]!;
    if (Array.isArray(cursor) && /^\d+$/.test(token) && Number(token) < cursor.length) cursor = cursor[Number(token)];
    else if (cursor !== null && typeof cursor === "object" && Object.hasOwn(cursor, token)) cursor = (cursor as Record<string, unknown>)[token];
    else throw new ProposalError("INVALID_PROPOSAL", `proposal path parent is missing at ${path || "$"}`, path);
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(cursor)) {
    if (!/^(?:0|[1-9]\d*)$/.test(last)) {
      throw new ProposalError("INVALID_PROPOSAL", `proposal array index must use canonical decimal form at ${path}`, path);
    }
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= cursor.length || !side.exists) {
      throw new ProposalError("INVALID_PROPOSAL", `proposal array change must replace an existing index at ${path}`, path);
    }
    cursor[index] = deepClone(side.value);
  } else if (cursor !== null && typeof cursor === "object") {
    if (side.exists) Object.defineProperty(cursor, last, { value: deepClone(side.value), enumerable: true, configurable: true, writable: true });
    else delete (cursor as Record<string, unknown>)[last];
  } else throw new ProposalError("INVALID_PROPOSAL", `proposal path parent is not a container at ${path}`, path);
  return root;
}

function validateCandidate(project: Project): void {
  const errors = validateProject(project);
  if (errors.length > 0) {
    throw new ProposalError("INVALID_PROPOSAL_RESULT", `proposal result is invalid at ${errors[0]!.path}: ${errors[0]!.msg}`, errors[0]!.path, errors[0]!.msg, undefined, errors);
  }
  const mapIds = new Set<string>();
  for (let mapIndex = 0; mapIndex < project.maps.length; mapIndex++) {
    const map = project.maps[mapIndex]!;
    try {
      validateMapDefStructure(map);
    } catch (error) {
      errors.push({ path: `$.maps[${mapIndex}]`, msg: error instanceof Error ? error.message : String(error) });
    }
    if (mapIds.has(map.id)) errors.push({ path: `$.maps[${mapIndex}].id`, msg: `duplicate map id ${JSON.stringify(map.id)}` });
    mapIds.add(map.id);
    const eventIds = new Set<string>();
    for (let eventIndex = 0; eventIndex < (map.events ?? []).length; eventIndex++) {
      const event = map.events![eventIndex]!;
      if (eventIds.has(event.id)) errors.push({ path: `$.maps[${mapIndex}].events[${eventIndex}].id`, msg: `duplicate event id ${JSON.stringify(event.id)}` });
      eventIds.add(event.id);
      if (event.x < 0 || event.y < 0 || event.x + (event.w ?? 1) > map.width || event.y + (event.h ?? 1) > map.height) {
        errors.push({ path: `$.maps[${mapIndex}].events[${eventIndex}]`, msg: "event footprint is outside the map" });
      }
    }
  }
  const startMap = project.maps.find((map) => map.id === project.start.map);
  if (!startMap) errors.push({ path: "$.start.map", msg: `unknown start map ${JSON.stringify(project.start.map)}` });
  else if (project.start.x < 0 || project.start.y < 0 || project.start.x >= startMap.width || project.start.y >= startMap.height) {
    errors.push({ path: "$.start", msg: "start is outside its map" });
  }
  if (errors.length > 0) {
    throw new ProposalError("INVALID_PROPOSAL_RESULT", `proposal result is invalid at ${errors[0]!.path}: ${errors[0]!.msg}`, errors[0]!.path, errors[0]!.msg, undefined, errors);
  }
}

/** Apply reversible changes after checking every local before value. Unlike
 * applyProposalHunks this performs no Project validation, so the same
 * mechanics can drive a sharded logical document (shell + shards). */
export function applyProposalChanges(root: unknown, changes: readonly EditChange[]): unknown {
  let next: unknown = deepClone(root);
  for (const change of changes) {
    const actual = sideAt(next, change.path);
    if (!sameSide(actual, change.before)) {
      throw new ProposalError("PROPOSAL_HUNK_CONFLICT", `proposal precondition failed at ${change.path || "$"}`, change.path || "$", change.before, actual);
    }
    next = setSide(next, change.path, change.after);
  }
  return next;
}

function applyChanges(project: Project, changes: readonly EditChange[]): Project {
  const next = applyProposalChanges(project, changes) as Project;
  validateCandidate(next);
  return next;
}

function overlap(a: string, b: string): boolean {
  if (a === b || a === "" || b === "") return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** JSON Schema plus invariants that schema cannot express: unique hunk ids,
 * valid JSON pointers and non-overlapping paths. Non-overlap makes every
 * hunk independently reviewable, regardless of acceptance order. */
export function proposalErrors(value: unknown): VError[] {
  const errors = validateSchema(proposalSchema, value);
  if (errors.length > 0) return errors;
  const proposal = value as EditProposal;
  const ids = new Set<string>();
  const paths: { path: string; hunk: string }[] = [];
  const assetPaths = new Map<string, string>();
  const allAssets = Object.create(null) as Record<string, unknown>;
  for (let hunkIndex = 0; hunkIndex < proposal.hunks.length; hunkIndex++) {
    const hunk = proposal.hunks[hunkIndex]!;
    if (ids.has(hunk.id)) {
      errors.push({ path: `$.hunks[${hunkIndex}].id`, msg: `duplicate hunk id ${JSON.stringify(hunk.id)}` });
    }
    ids.add(hunk.id);
    try {
      for (const change of hunk.changes) pointerTokens(change.path);
    } catch (error) {
      errors.push({
        path: `$.hunks[${hunkIndex}].changes`,
        msg: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const change of hunk.changes) {
      const prior = paths.find((item) => overlap(item.path, change.path));
      if (prior) {
        errors.push({
          path: `$.hunks[${hunkIndex}].changes`,
          msg: `path ${JSON.stringify(change.path)} overlaps ${JSON.stringify(prior.path)} in hunk ${JSON.stringify(prior.hunk)}; combine dependent edits into one hunk`,
        });
      } else {
        paths.push({ path: change.path, hunk: hunk.id });
      }
    }
    if (hunk.assets !== undefined) {
      const checked = validatePngAssetRecord(hunk.assets, `$.hunks[${hunkIndex}].assets`);
      if (!checked.ok) {
        errors.push({ path: checked.issue.path, msg: checked.issue.message });
      }
      for (const [path, asset] of Object.entries(hunk.assets)) {
        const prior = assetPaths.get(path);
        if (prior !== undefined) {
          errors.push({
            path: `$.hunks[${hunkIndex}].assets`,
            msg: `asset path ${JSON.stringify(path)} also appears in hunk ${JSON.stringify(prior)}; combine dependent assets into one hunk`,
          });
        } else {
          assetPaths.set(path, hunk.id);
          Object.defineProperty(allAssets, path, { value: asset, enumerable: true, configurable: true, writable: true });
        }
      }
    }
  }
  const combinedAssets = validatePngAssetRecord(allAssets, "$.hunks");
  if (!combinedAssets.ok) errors.push({ path: combinedAssets.issue.path, msg: combinedAssets.issue.message });
  return errors;
}

export function parseProposal(value: unknown): EditProposal {
  const errors = proposalErrors(value);
  if (errors.length > 0) {
    throw new ProposalError(
      "INVALID_PROPOSAL",
      `invalid proposal at ${errors[0]!.path}: ${errors[0]!.msg}`,
      errors[0]!.path,
      errors[0]!.msg,
      undefined,
      errors,
    );
  }
  return deepClone(value) as EditProposal;
}

export type ProposalAssetLookup = (path: string) => string | null;

export function assessHunkValue(
  root: unknown,
  hunk: EditProposal["hunks"][number],
  assetData?: ProposalAssetLookup,
): HunkAssessment {
  let before = 0;
  let after = 0;
  const conflicts: string[] = [];
  for (const change of hunk.changes) {
    const actual = sideAt(root, change.path);
    if (sameSide(actual, change.before)) before++;
    else if (sameSide(actual, change.after)) after++;
    else conflicts.push(change.path || "$");
  }
  const assets = Object.entries(hunk.assets ?? {});
  for (const [path, asset] of assets) {
    const actual = assetData?.(path) ?? null;
    if (actual === null) before++;
    else if (actual === asset.data) after++;
    else conflicts.push(`asset:${path}`);
  }
  const total = hunk.changes.length + assets.length;
  const state = conflicts.length > 0
    ? "conflict"
    : before === total
      ? "clean"
      : after === total
        ? "already-applied"
        : "partially-applied";
  return { id: hunk.id, state, conflicts };
}

export function assessHunk(
  project: Project,
  hunk: EditProposal["hunks"][number],
  assetData?: ProposalAssetLookup,
): HunkAssessment {
  return assessHunkValue(project, hunk, assetData);
}

export function assessProposal(
  project: Project,
  value: unknown,
  assetData?: ProposalAssetLookup,
): ProposalAssessment {
  const proposal = parseProposal(value);
  const hunks = proposal.hunks.map((hunk) => assessHunk(project, hunk, assetData));
  return {
    baseMatches: proposalSemanticHash(project) === proposal.baseHash,
    hasConflicts: hunks.some((hunk) => hunk.state === "conflict" || hunk.state === "partially-applied"),
    hunks,
  };
}

/** Apply several clean hunks as one validated project transaction. Callers
 * can put the returned project into one editor history entry. */
export function applyProposalHunks(
  project: Project,
  value: unknown,
  hunkIds: readonly string[],
  assetData?: ProposalAssetLookup,
): Project {
  const proposal = parseProposal(value);
  const wanted = new Set(hunkIds);
  if (wanted.size !== hunkIds.length) {
    throw new ProposalError("INVALID_PROPOSAL_SELECTION", "a hunk may be selected only once", "$.hunks");
  }
  const selected = proposal.hunks.filter((hunk) => wanted.has(hunk.id));
  if (selected.length !== wanted.size || selected.length === 0) {
    throw new ProposalError(
      "INVALID_PROPOSAL_SELECTION",
      "proposal hunk selection is empty or names an unknown hunk",
      "$.hunks",
      proposal.hunks.map((hunk) => hunk.id),
      hunkIds,
    );
  }
  const changes = [] as EditProposal["hunks"][number]["changes"];
  for (const hunk of selected) {
    const assessment = assessHunk(project, hunk, assetData);
    if (assessment.state !== "clean") {
      throw new ProposalError(
        "PROPOSAL_HUNK_CONFLICT",
        `hunk ${JSON.stringify(hunk.id)} is ${assessment.state} and cannot be applied`,
        `$.hunks.${hunk.id}`,
        "clean",
        assessment.state,
        assessment.conflicts,
      );
    }
    changes.push(...hunk.changes);
  }
  return applyChanges(project, changes);
}

export function decideProposalHunks(
  value: unknown,
  hunkIds: readonly string[],
  status: ProposalDecisionStatus,
  decidedAt: string = new Date().toISOString(),
  source?: string,
): EditProposal {
  const proposal = parseProposal(value);
  const wanted = new Set(hunkIds);
  if (wanted.size !== hunkIds.length || wanted.size === 0 ||
      proposal.hunks.filter((hunk) => wanted.has(hunk.id)).length !== wanted.size) {
    throw new ProposalError("INVALID_PROPOSAL_SELECTION", "decision names an empty, duplicate, or unknown hunk", "$.hunks");
  }
  const next: EditProposal = {
    ...proposal,
    hunks: proposal.hunks.map((hunk) => wanted.has(hunk.id)
      ? { ...hunk, decision: { status, decidedAt, ...(source === undefined ? {} : { source }) } }
      : hunk),
  };
  return parseProposal(next);
}

export const proposalComplete = (proposal: EditProposal): boolean =>
  proposal.hunks.every((hunk) => hunk.decision !== undefined);

function denseUpper(map: MapDef): TileId[] {
  const dense: TileId[] = new Array(map.width * map.height).fill(null);
  for (const [index, tile] of map.upper ?? []) if (index >= 0 && index < dense.length) dense[index] = tile;
  return dense;
}

function tileAt(
  map: MapDef,
  dense: readonly TileId[],
  x: number,
  y: number,
): TileId | undefined {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return undefined;
  return dense[y * map.width + x] ?? null;
}

function appendTileDiffs(
  tiles: ProposalTilePreview[],
  mapId: string,
  layer: ProposalTilePreview["layer"],
  beforeMap: MapDef,
  beforeTiles: readonly TileId[],
  afterMap: MapDef,
  afterTiles: readonly TileId[],
): void {
  const width = Math.max(beforeMap.width, afterMap.width);
  const height = Math.max(beforeMap.height, afterMap.height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const before = tileAt(beforeMap, beforeTiles, x, y);
      const after = tileAt(afterMap, afterTiles, x, y);
      if (before === after) continue;
      // A resize changes the map boundary, not every implicit void cell.
      // Still show authored tiles that are cropped or painted into an
      // expanded region so the reviewer sees content loss/addition.
      if (after === undefined && (before === undefined || before === null)) continue;
      if (before === undefined && (after === undefined || after === null)) continue;
      tiles.push({ mapId, layer, x, y, tile: after ?? null });
    }
  }
}

function eventGeometry(event: GameEvent): { x: number; y: number; w: number; h: number } {
  return { x: event.x, y: event.y, w: event.w ?? 1, h: event.h ?? 1 };
}

function eventEqual(a: GameEvent, b: GameEvent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Derive display primitives by comparing the live document with selected
 * hunks applied. It never mutates the input and therefore cannot dirty or
 * enter editor history merely by previewing. */
export function previewProposalHunks(
  project: Project,
  value: unknown,
  hunkIds: readonly string[],
): ProposalPreview {
  const next = applyProposalHunks(project, value, hunkIds);
  const tiles: ProposalTilePreview[] = [];
  const events: ProposalEventPreview[] = [];
  const maps: ProposalMapPreview[] = [];
  for (let mapIndex = 0; mapIndex < project.maps.length; mapIndex++) {
    const beforeMap = project.maps[mapIndex]!;
    const afterMap = next.maps[mapIndex];
    if (!afterMap) continue;
    // The canvas still displays the live (before) document. Bind previews to
    // that stable id even when this hunk also renames the map.
    const mapId = beforeMap.id;
    if (beforeMap.width !== afterMap.width || beforeMap.height !== afterMap.height) {
      maps.push({ mapId, width: afterMap.width, height: afterMap.height });
    }
    appendTileDiffs(tiles, mapId, "ground", beforeMap, beforeMap.ground, afterMap, afterMap.ground);
    const beforeUpper = denseUpper(beforeMap);
    const afterUpper = denseUpper(afterMap);
    appendTileDiffs(tiles, mapId, "upper", beforeMap, beforeUpper, afterMap, afterUpper);
    const beforeEvents = new Map((beforeMap.events ?? []).map((event) => [event.id, event]));
    const afterEvents = new Map((afterMap.events ?? []).map((event) => [event.id, event]));
    for (const [id, event] of beforeEvents) {
      const after = afterEvents.get(id);
      if (!after) {
        events.push({ mapId, kind: "deleted", id, ...eventGeometry(event) });
        continue;
      }
      if (eventEqual(event, after)) continue;
      const beforeGeom = eventGeometry(event);
      const afterGeom = eventGeometry(after);
      const moved = beforeGeom.x !== afterGeom.x || beforeGeom.y !== afterGeom.y;
      events.push({
        mapId,
        kind: moved ? "moved" : "changed",
        id,
        ...afterGeom,
        ...(moved ? { fromX: beforeGeom.x, fromY: beforeGeom.y } : {}),
      });
    }
    for (const [id, event] of afterEvents) {
      if (!beforeEvents.has(id)) events.push({ mapId, kind: "added", id, ...eventGeometry(event) });
    }
  }
  return { tiles, events, maps };
}
