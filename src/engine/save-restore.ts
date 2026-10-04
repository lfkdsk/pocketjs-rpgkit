// src/engine/save-restore.ts — map-aware restore gate (R1202-3).
//
// save-validate.ts is deliberately map-agnostic (the engine core has no
// World): it proves a decoded snapshot is internally consistent. This module
// proves it fits the map THIS build actually runs, before any live mover or
// interpreter is replaced:
//
//   1. the snapshot map id is the live map id
//   2. the saved player tile lies inside the map and is standable under the
//      live passage table (a checksum-valid save with tx=1_000_000 otherwise
//      restores the mover off-map, where every direction is blocked and the
//      session soft-locks)
//   3. every serialized fiber names an event the live map owns, parks on a
//      page that exists, and that page's trigger matches the fiber's
//      parallel flag
//   4. a saved character table only names events the live map owns, on
//      pages they have, standing inside the map, and a step in flight
//      lands inside the map
//
// Pure TS: the host hands in the live MapDef + cooked PassageTable. A
// refusal returns a reason string; the caller throws SaveError("shape") and
// keeps the running session untouched.

import { MAX_FIBER_STACK_DEPTH } from "./interpreter.ts";
import type { MapDef } from "./types.ts";
import { isStandable, withTilePropertyOverrides, type PassageTable } from "./passability.ts";
import type { SaveErrorCode, SaveSnapshot } from "./save.ts";
import {
  SAVE_MAX_DEPTH,
  SaveError,
  canSave,
  cloneLeftMap,
  cloneSnapshot,
  createSessionSnapshot,
  decodeEnvelopeText,
  decodeSaveCode,
  saveDepthExceeded,
} from "./save.ts";
import { validateSnapshot } from "./save-validate.ts";
import { MapNotReadyError } from "./map-repository.ts";
import { cloneInterp, createSwitchState, reconstructLabelScopes } from "./interpreter.ts";
import { cloneChars, createChars } from "./chars.ts";
import { clonePathSearch } from "./pathfind.ts";
import { decodeExtension } from "./extensions.ts";
import {
  acquireSessionMap,
  releaseSessionMapsExcept,
  type Session,
  type SessionState,
} from "./session.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Returns null when the snapshot is safe to restore onto this map,
 *  otherwise a human-readable reason. */
export function restoreProblem(
  snap: SaveSnapshot,
  map: MapDef,
  table: PassageTable,
): string | null {
  if (snap.map !== map.id) {
    return `save is for map ${snap.map}, not ${map.id}`;
  }

  // Player tile bounds + standability. The pixel origin (px == 16*tx etc.)
  // and the tile-boundary safe point are already guaranteed by
  // save-validate.ts; here we only need the live map's geometry.
  const { tx, ty } = snap.player;
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) {
    return `player tile (${tx},${ty}) is outside ${map.id} (${map.width}x${map.height})`;
  }
  let effectiveTable: PassageTable;
  try {
    effectiveTable = withTilePropertyOverrides(table, snap.interp.tileProperties);
  } catch (error) {
    return `runtime tile properties are invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isStandable(effectiveTable, tx, ty)) {
    return `player tile (${tx},${ty}) is not standable on ${map.id}`;
  }

  // Fiber provenance: each live fiber must belong to an event this map
  // defines, on an existing page, with a trigger consistent with the
  // fiber's parallel flag. A fiber for a deleted/reordered event would
  // otherwise run commands the live map never authored.
  const events = new Map((map.events ?? []).map((e) => [e.id, e]));
  const fibers: [string, Record<string, unknown>][] = [];
  const interp = snap.interp as unknown as Record<string, unknown>;
  if (interp.main !== null && interp.main !== undefined) {
    if (!isRecord(interp.main)) return "interp.main: fiber must be an object";
    fibers.push(["interp.main", interp.main]);
  }
  if (isRecord(interp.parallels)) {
    for (const [k, f] of Object.entries(interp.parallels)) {
      if (!isRecord(f)) return `interp.parallels.${k}: fiber must be an object`;
      fibers.push([`interp.parallels.${k}`, f]);
    }
  }
  for (const [path, fiber] of fibers) {
    const key = typeof fiber.key === "string" ? fiber.key : "";
    const slash = key.indexOf("/");
    const eventId = slash >= 0 ? key.slice(slash + 1) : "";
    const ev = events.get(eventId);
    if (!ev) return `${path}: fiber event "${eventId}" does not exist on ${map.id}`;
    const pageIndex = fiber.pageIndex;
    if (typeof pageIndex !== "number" || !Number.isInteger(pageIndex) ||
      pageIndex < 0 || pageIndex >= ev.pages.length) {
      return `${path}: page ${String(pageIndex)} does not exist for event "${eventId}"`;
    }
    const page = ev.pages[pageIndex]!;
    const wantParallel = fiber.parallel === true;
    if (page.trigger === "parallel" !== wantParallel) {
      return `${path}: fiber parallel flag does not match page trigger "${page.trigger}"`;
    }
    const stack = fiber.stack;
    if (!Array.isArray(stack) || stack.length > MAX_FIBER_STACK_DEPTH) {
      return `${path}: stack exceeds ${MAX_FIBER_STACK_DEPTH} frames`;
    }
  }

  // Character provenance: save-validate.ts proved the table's shape; each
  // character must also be an event of this map, on one of its pages,
  // inside the map, and a step in flight must land inside it too.
  const chars = snap.mapRuntime?.chars.chars;
  if (chars) {
    for (const id of Object.keys(chars)) {
      const ch = chars[id]!;
      const path = `mapRuntime.chars.${id}`;
      const ev = events.get(id);
      if (!ev) return `${path}: event "${id}" does not exist on ${map.id}`;
      if (ch.pageIndex >= ev.pages.length) {
        return `${path}: page ${ch.pageIndex} does not exist for event "${id}"`;
      }
      if (ch.tx >= map.width || ch.ty >= map.height) {
        return `${path}: tile (${ch.tx},${ch.ty}) is outside ${map.id} (${map.width}x${map.height})`;
      }
      if (ch.moving) {
        const nx = ch.tx + (ch.stepDir === 3 ? 1 : ch.stepDir === 1 ? -1 : 0);
        const ny = ch.ty + (ch.stepDir === 0 ? 1 : ch.stepDir === 2 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) {
          return `${path}: step target (${nx},${ny}) is outside ${map.id} (${map.width}x${map.height})`;
        }
      }
      for (const route of [ch.route, ch.patrol]) {
        const search = route?.plan?.search;
        if (search && (search.W !== map.width || search.N !== map.width * map.height)) {
          return `${path}: path search does not match the size of ${map.id}`;
        }
      }
    }
  }
  const search = snap.mapRuntime?.playerRoute?.plan?.search;
  if (search && (search.W !== map.width || search.N !== map.width * map.height)) {
    return `mapRuntime.playerRoute: path search does not match the size of ${map.id}`;
  }
  return null;
}

/** Restore a decoded snapshot, acquiring an evicted destination map before
 * validation. The repository and compile cache remain derived Session data;
 * the returned reducer state contains only the saved map id and state. */
export function restoreSessionSnapshot(
  session: Session,
  snap: SaveSnapshot,
): SessionState {
  const map = acquireSessionMap(session, snap.map);
  const table = session.tables.get(snap.map)!;
  const problem = restoreProblem(snap, map, table);
  if (problem) throw new SaveError("shape", `save cannot be restored: ${problem}`);
  const interp = cloneInterp(snap.interp);
  // B1 (fix 3): the restore boundary normalizes through
  // the same constructor a fresh session uses, so this entry point shares
  // clampFiniteVar with every other numeric-bank write/construction site
  // even though save-validate.ts already requires a decoded envelope's
  // gold/items/shopStock/variables to be safe integers.
  interp.sw = createSwitchState(interp.sw);
  // Saves written before frames recorded their label-scope root lack the
  // `unit` markers that keep a common event's label lookups in its own
  // list. Rebuild them from the fiber/page/common stack structure so a
  // restored common event does not silently fall back to the page scope.
  reconstructLabelScopes(interp);
  let ext;
  try {
    ext = decodeExtension(session.extensions, snap.ext);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SaveError("shape", `save extension state is invalid: ${reason}`);
  }
  // A save without map runtime (written before it was recorded) restores
  // as it always did: the next tick spawns the characters from the map.
  const runtime = snap.mapRuntime;
  const playerRoute = runtime?.playerRoute ?? null;
  const state: SessionState = {
    frame: Math.floor(interp.frame / session.ticksPerFrame),
    mapId: snap.map,
    sw: interp.sw,
    move: { ...snap.player },
    // cloneChars also turns saved path-search arrays back into typed arrays.
    chars: runtime ? cloneChars(runtime.chars) : createChars(),
    interp,
    fade: runtime?.fade ? { ...runtime.fade } : null,
    playerRoute: playerRoute
      ? {
          ...playerRoute,
          steps: [...playerRoute.steps],
          plan: playerRoute.plan
            ? {
                ...playerRoute.plan,
                dirs: [...playerRoute.plan.dirs],
                search: clonePathSearch(playerRoute.plan.search),
                approach: playerRoute.plan.approach ? { ...playerRoute.plan.approach } : null,
              }
            : null,
        }
      : null,
    ext,
    scene: null,
  };
  // Older saves have no left-map snapshot: that map shows its entry preview.
  if (runtime?.leftMap) state.leftMap = cloneLeftMap(runtime.leftMap);
  releaseSessionMapsExcept(session, [snap.map]);
  return state;
}

/** Decode with this session's content identity, then rebuild the target map
 * cache and reducer state. A manifest/schema mismatch is rejected before any
 * map bytes are acquired. */
export function restoreSessionEnvelope(session: Session, text: string): SessionState {
  return restoreSessionSnapshot(session, decodeEnvelopeText(text, session.content));
}

// --- structured save/load ---------------------------------------------------

/** Why a session save or load did not happen. The save-data codes are
 *  SaveErrorCode's (`bad-json`, `format`, `version`, `checksum`, `content`
 *  for a save from another build, `shape` for invalid or unrestorable
 *  state); `not-safe-point` refuses a save taken mid-step, mid-dialogue or
 *  with external work pending; `map-not-ready` asks an asynchronous map
 *  repository to prepare `mapId` before the load is retried. */
export type SessionSaveErrorCode = SaveErrorCode | "not-safe-point" | "map-not-ready";

export interface SessionSaveError {
  code: SessionSaveErrorCode;
  message: string;
  /** The map to prepare, on `map-not-ready`. */
  mapId?: string;
}

export type SessionSaveResult =
  | { ok: true; snapshot: SaveSnapshot }
  | { ok: false; error: SessionSaveError };

export type SessionLoadResult =
  | {
    ok: true;
    /** Reducer state to continue from. */
    state: SessionState;
    /** Button mask held on the save frame (the previous mask to resume from). */
    held: number;
    snapshot: SaveSnapshot;
  }
  | { ok: false; error: SessionSaveError };

/** Snapshot a live session, or explain why this frame is not a save point.
 *  Never throws for a state the reducer produced. */
export function saveSession(session: Session, state: SessionState, held: number): SessionSaveResult {
  if (!canSave(state.move, state.interp, state.scene, state.handoff)) {
    return {
      ok: false,
      error: {
        code: "not-safe-point",
        message: "not a save point: the player is mid-step or handoff, a message, menu or scene is open, or event work is pending",
      },
    };
  }
  try {
    const snapshot = createSessionSnapshot(session, state, held);
    // Refuse now what a load would refuse: game extension state nested
    // past the decoder's depth bound.
    if (saveDepthExceeded(snapshot)) {
      return {
        ok: false,
        error: { code: "shape", message: `save state nests deeper than ${SAVE_MAX_DEPTH} levels` },
      };
    }
    return { ok: true, snapshot };
  } catch (error) {
    return { ok: false, error: toSessionSaveError(error) };
  }
}

/** Decode and restore a save without touching any live state: `input` is a
 *  snapshot object, an envelope's JSON text or a save code (either
 *  encoding). Text input is checked against `session.content`, so a save
 *  from another content build is refused with `content`. The returned state
 *  replaces the running one; nothing else needs resetting. */
export function loadSession(session: Session, input: SaveSnapshot | string): SessionLoadResult {
  let snapshot: SaveSnapshot;
  try {
    if (typeof input === "string") {
      snapshot = input.trimStart().startsWith("{")
        ? decodeEnvelopeText(input, session.content)
        : decodeSaveCode(input, session.content);
    } else {
      const reason = validateSnapshot(input);
      if (reason !== null) throw new SaveError("shape", `save state is invalid: ${reason}`);
      snapshot = cloneSnapshot(input);
    }
  } catch (error) {
    return { ok: false, error: toSessionSaveError(error) };
  }
  try {
    const state = restoreSessionSnapshot(session, snapshot);
    return { ok: true, state, held: snapshot.held, snapshot };
  } catch (error) {
    return { ok: false, error: toSessionSaveError(error) };
  }
}

function toSessionSaveError(error: unknown): SessionSaveError {
  if (error instanceof SaveError) return { code: error.code, message: error.message };
  if (error instanceof MapNotReadyError) {
    return { code: "map-not-ready", message: error.message, mapId: error.mapId };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "shape", message: `save cannot be restored: ${message}` };
}
