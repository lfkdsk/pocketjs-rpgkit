// src/engine/save.ts — P1⑤ save/load snapshot.
//
// One reducer snapshot covers the whole resumable session:
//   map      — current map id (P1④ transfers change it)
//   player   — the mover's tile/pixel position, facing, step phase
//   held     — the BTN mask on the save frame, restored as the host's
//              previous-mask so pressed edges line up after a load
//   interp   — the FULL interpreter state (engine/interpreter.ts): frame
//              clock, switches/variables/self-switches/items/gold, the
//              mulberry32 RNG cursor, blocking and parallel fibers (with
//              their compiled stacks), modal, erased/touch latches
//   mapRuntime — the current map's character table (cells, facing, step
//              interpolation, page, running and patrol routes with their
//              progress, the wander RNG), the player's forced route and a
//              transfer fade-in. Older v1 saves omit it; their restore
//              rebuilds the characters from the map as before.
//
// Nothing here is host-derived: a save point is a SAFE POINT — mover at a
// tile boundary, no blocking fiber except a resumable waited screen effect,
// no modal, no parked external request —
// so the restored state folds the same future tape into the same states
// and the same pixels (docs/SIMULATION.md). The envelope carries a format
// id, a version number and an FNV-1a checksum over canonicalized JSON;
// truncation, a pasted typo, or a future-version file is refused with a
// typed code instead of loading garbage.
//
// The web/other-targets fallback is the save CODE: the same envelope
// encoded as URL-safe base64 (no padding), copied in/out by hand. Its
// alphabet is A-Z a-z 0-9 - _, every key of which the framework OSK
// types. By default the envelope is DEFLATE-compressed first and the code
// starts with "z1"; a plain code (always starting "e", the base64 of "{")
// still decodes. Pure TS, no host imports, QuickJS-safe (no
// TextEncoder/btoa).

import type { MovementState } from "./movement.ts";
import type { CharsState, PathPlan, RouteRun } from "./chars.ts";
import type { PathSearchState } from "./pathfind.ts";
import type { InterpState } from "./interpreter.ts";
import { cloneInterp, createSwitchState, isBusy } from "./interpreter.ts";
import { deepClone, keyedRecord } from "./clone.ts";
import { assertJsonValue, encodeExtension } from "./extensions.ts";
import { envelopeConsistent, validateSnapshot } from "./save-validate.ts";
import { InflateError, deflateRaw, inflateRaw } from "./deflate.ts";
import { utf8BytesWithin } from "./utf8.ts";
import type { MapContentIdentity } from "./map-repository.ts";
import { MAP_SCHEMA_HASH, describeMapSchemaRefusal, isCompatibleMapSchemaHash } from "./schema-identity.ts";
import type { JsonValue } from "./types.ts";
import type { FadeState, LeftMapSnapshot, PlayerRoute, Session, SessionState } from "./session.ts";

export const SAVE_FORMAT = "rpgkit-save/v1" as const;
export const SAVE_VERSION = 1 as const;

/** Slot 1..3 (save/slot-N.json on an fs host). */
export const SLOT_MIN = 1;
export const SLOT_MAX = 3;

// --- snapshot ---------------------------------------------------------------

export interface SaveSnapshot {
  /** Current map id. */
  map: string;
  /** Mover state at a tile boundary. */
  player: MovementState;
  /** BTN mask held on the save frame (host previous-mask seed). */
  held: number;
  /** Full interpreter state, cues drained and no request parked. */
  interp: InterpState;
  /** Game-owned state in its encoded JSON form. Older v1 saves hydrate null. */
  ext: JsonValue;
  /** The current map's runtime outside the interpreter. Absent in saves
   *  written before it was recorded (and in snapshots built without a
   *  session); restoring those rebuilds the characters from the map. */
  mapRuntime?: SaveMapRuntime;
}

/** Map-visit state the session keeps beside the interpreter. Everything in
 *  it decides future frames: where each character stands and faces, its
 *  step interpolation, its running route and progress (including a
 *  pathfinding search in flight), its page patrol, the shared wander RNG,
 *  the player's forced route and a transfer fade-in. Plain JSON: path
 *  search buffers are stored as number arrays. */
export interface SaveMapRuntime {
  chars: CharsState;
  playerRoute: PlayerRoute | null;
  fade: FadeState | null;
  /** The frozen snapshot of the map left by the latest seamless handoff.
   *  Present only in seamless-world saves taken while it is held; a save
   *  without it shows that map's map-entry preview instead. */
  leftMap?: LeftMapSnapshot;
}

/** A save is only valid at a safe point: the mover rests on a tile and no
 *  modal / queued external request / scene owns the session. A main fiber
 *  parked on `screenWait` is safe because both its clock and presentation
 *  descriptor are reducer state; every other blocking mode remains barred.
 *  Parallel fibers serialize in their running state. */
export function canSave(
  player: MovementState,
  interp: InterpState,
  scene: unknown = null,
  handoff: unknown = null,
): boolean {
  return (
    !player.moving &&
    player.phase === 0 &&
    (!isBusy(interp) || interp.main?.mode === "screenWait") &&
    interp.error === undefined &&
    interp.modal === null &&
    interp.pendingTransfer === null &&
    interp.pendingMoveRoutes.length === 0 &&
    interp.pendingPlacements.length === 0 &&
    interp.abortedRoutes.length === 0 &&
    interp.pendingBattles.length === 0 &&
    (interp.pendingScenes?.length ?? 0) === 0 &&
    scene === null &&
    handoff == null
  );
}

/** Deep-copy a snapshot without host built-ins. The desktop QuickJS realm
 *  has no structuredClone (F1/task-1173); movement state is a flat record
 *  and interpreter state goes through its own hand-written cloner. */
export function cloneSnapshot(snap: SaveSnapshot): SaveSnapshot {
  const out: SaveSnapshot = {
    map: snap.map,
    player: { ...snap.player },
    held: snap.held >>> 0,
    interp: cloneInterp(snap.interp),
    ext: deepClone((snap as SaveSnapshot & { ext?: JsonValue }).ext ?? null),
  };
  if (snap.mapRuntime !== undefined) out.mapRuntime = cloneMapRuntime(snap.mapRuntime);
  return out;
}

/** Copy session map runtime into its plain-JSON save form. Typed path
 *  search buffers (live state) and number arrays (a decoded save) both
 *  become fresh number arrays; chars.ts revives either form. */
export function cloneMapRuntime(rt: SaveMapRuntime): SaveMapRuntime {
  const chars: CharsState["chars"] = keyedRecord();
  for (const id of Object.keys(rt.chars.chars)) {
    const ch = rt.chars.chars[id]!;
    chars[id] = { ...ch, route: jsonRoute(ch.route), patrol: jsonRoute(ch.patrol) };
  }
  return {
    chars: { rng: rt.chars.rng, chars },
    playerRoute: rt.playerRoute
      ? {
          ...rt.playerRoute,
          steps: deepClone(rt.playerRoute.steps),
          plan: jsonPlan(rt.playerRoute.plan),
        }
      : null,
    fade: rt.fade ? { ...rt.fade } : null,
    ...(rt.leftMap ? { leftMap: cloneLeftMap(rt.leftMap) } : {}),
  };
}

export function cloneLeftMap(left: Readonly<LeftMapSnapshot>): LeftMapSnapshot {
  return { ...left, actors: left.actors.map((actor) => ({ ...actor })) };
}

function jsonRoute(route: RouteRun | null): RouteRun | null {
  return route ? { ...route, steps: deepClone(route.steps), plan: jsonPlan(route.plan) } : null;
}

function jsonPlan(plan: PathPlan | null): PathPlan | null {
  if (!plan) return null;
  return {
    ...plan,
    search: jsonSearch(plan.search),
    dirs: [...plan.dirs],
    approach: plan.approach
      ? {
          ...plan.approach,
          target: plan.approach.target === "player" ? "player" : { ...plan.approach.target },
        }
      : null,
  };
}

function jsonSearch(search: PathSearchState | null): PathSearchState | null {
  if (!search) return null;
  const numbers = (v: ArrayLike<number> | Record<string, number>, n: number): number[] => {
    const out = new Array<number>(n);
    const src = v as Record<number, number>;
    for (let i = 0; i < n; i++) out[i] = src[i]!;
    return out;
  };
  // The save form holds plain arrays where the live state holds typed
  // arrays; clonePathSearch converts back on restore.
  return {
    ...search,
    parent: numbers(search.parent, search.N),
    queue: numbers(search.queue, search.N),
    blockedMask: search.blockedMask ? numbers(search.blockedMask, search.N) : null,
  } as unknown as PathSearchState;
}

export function createSnapshot(
  map: string,
  player: MovementState,
  interp: InterpState,
  held: number,
  ext: JsonValue = null,
  scene: unknown = null,
  mapRuntime?: SaveMapRuntime,
  handoff: unknown = null,
): SaveSnapshot {
  if (!canSave(player, interp, scene, handoff)) {
    throw new Error("save: snapshot is only valid at a tile boundary with no modal or scene open and no external work pending");
  }
  assertJsonValue(ext, "save extension state");
  return normalizeInterp(cloneSnapshot({ map, player, held, interp, ext, ...(mapRuntime ? { mapRuntime } : {}) }));
}

/** Session-aware save entry point. It applies the registered extension
 * codec and rejects active scenes before constructing the checksum payload. */
export function createSessionSnapshot(
  session: Session,
  state: SessionState,
  held: number,
): SaveSnapshot {
  return createSnapshot(
    state.mapId,
    state.move,
    state.interp,
    held,
    encodeExtension(session.extensions, state.ext),
    state.scene,
    {
      chars: state.chars,
      playerRoute: state.playerRoute,
      fade: state.fade,
      ...(state.leftMap ? { leftMap: state.leftMap } : {}),
    },
    state.handoff,
  );
}

/** Drop between-frame transient fields. The battle queue is persistent at
 * runtime, but can only be empty at the safe point checked above. */
function normalizeInterp(snap: SaveSnapshot): SaveSnapshot {
  normalizeInterpInPlace(snap.interp);
  return snap;
}

/** The between-fold normalization every resumable snapshot applies: the
 *  switch bank is re-created through the same constructor a fresh session
 *  and a restored save use (so the encoded shape is canonical and every
 *  numeric bank passes the same clamp a runtime write does), per-fold cues
 *  are drained, and between-fold request queues are dropped. Mutates the
 *  passed-in interpreter state (callers pass a copy when they need the
 *  original preserved). */
function normalizeInterpInPlace(interp: InterpState): void {
  // The per-frame cloneInterp copies the numeric banks verbatim (so an
  // ill-typed content value still reaches its fatal check). The save
  // boundary re-normalizes them through createSwitchState, so a state that
  // passes canSave always encodes into an envelope the decoder accepts.
  interp.sw = createSwitchState(interp.sw);
  interp.cues = [];
  // Host lifecycle callbacks are one-frame presentation outputs just like
  // sound cues. They are consumed by GameView and never replayed by a save,
  // rewind identity or restored reducer state.
  delete interp.hostActions;
  interp.pendingTransfer = null;
  interp.pendingMoveRoutes = [];
  interp.pendingBattles = [];
  // The scene queue is runtime-only: it must be empty at a save point, so
  // the field is dropped from the snapshot rather than serialized.
  delete (interp as Partial<InterpState>).pendingScenes;
  interp.pendingPlacements = [];
  interp.abortedRoutes = [];
}

/** Zero the pure playback clocks for state identity hashing: the absolute
 *  frame counter and every audio playback position advance every tick, and
 *  two states differing only in them fold the same future — BGM/BGS loop,
 *  and no condition reads a playback position (bgmPlaying reads the track
 *  id and paused flag). The persistent audio INTENT — which track plays, its
 *  volume/pitch, the paused flag, fade counters, the saved BGM, the ME
 *  countdown — is kept, so a state with music playing never hashes equal to
 *  silence. Mutates the passed-in interpreter state, which MUST be a copy
 *  the caller owns: the audio object is rebuilt (never mutated in place), so
 *  a live state sharing the interpreter's audio reference is untouched.
 *
 *  Every absolute time anchor is rebased onto the zeroed clock in the same
 *  pass: a fiber's `since` and a map animation's `start` are frame stamps,
 *  and the reducer judges waits, text reveals and one-shot animations as
 *  `frame - anchor`. Zeroing the frame without rebasing would merge two
 *  states parked at the same anchor but different elapsed time — same key,
 *  different future — so the reach search would drop a real map. Fibers
 *  and animations are rebuilt (never mutated in place), so a live state
 *  sharing those references is untouched. */
export function stripPlaybackClocksInPlace(interp: InterpState): void {
  const frame = interp.frame;
  interp.frame = 0;
  // Rebase every absolute time anchor onto the zeroed clock: a fiber's
  // `since` and a map animation's `start` are frame stamps, and the reducer
  // judges waits, text reveals and one-shot animations as `frame - anchor`.
  // Zeroing the frame without rebasing would merge two states parked at the
  // same anchor but different elapsed time — same key, different future — so
  // the reach search would drop a real map. Rebuilt, never mutated in
  // place, so a live state sharing these references is untouched.
  if (interp.main) interp.main = { ...interp.main, since: interp.main.since - frame };
  // The parallels record is shared with the live state (the caller's copy
  // is shallow), so rebuild it rather than reassigning its entries. Empty
  // in most projects, so skip the allocation entirely then.
  if (Object.keys(interp.parallels).length > 0) {
    interp.parallels = Object.fromEntries(
      Object.keys(interp.parallels).map((key) => {
        const fiber = interp.parallels[key]!;
        return [key, { ...fiber, since: fiber.since - frame }];
      }),
    );
  }
  if (interp.anims) interp.anims = interp.anims.map((a) => ({ ...a, start: a.start - frame }));
  const audio = interp.audio;
  if (!audio) return;
  interp.audio = {
    ...(audio.bgm ? { bgm: { ...audio.bgm, positionTicks: 0 } } : {}),
    ...(audio.bgs ? { bgs: { ...audio.bgs, positionTicks: 0 } } : {}),
    ...(audio.me ? { me: { ...audio.me, positionTicks: 0 } } : {}),
    ...(audio.savedBgm ? { savedBgm: { ...audio.savedBgm, positionTicks: 0 } } : {}),
  };
}

/** The tile-level identity of a movement state: which tile the player
 *  stands on and which way they face. The interpolation fields (pixel
 *  position, step phase, moving/walking/stepDir) are pure sub-tile progress
 *  — a step completes in a few ticks, no condition reads them, and the
 *  search plans at tile granularity (the passage table and trigger tiles
 *  are tile-based), so two movers on the same tile facing the same way
 *  fold the same future. */
function tileLevelMovement(move: MovementState): { tx: number; ty: number; facing: MovementState["facing"] } {
  return { tx: move.tx, ty: move.ty, facing: move.facing };
}

/** The canonical hash of a session state's resumable identity — the
 *  snapshot payload apart from the map runtime (map, player, the FULL
 *  interpreter state, ext), normalized so two states that fold the same
 *  reducer future hash equal. Character positions and routes stay out, as
 *  they always have (and so does the frozen display snapshot of the map
 *  left by a seamless handoff, which only presentation reads): the reach search plans at the level of story state and
 *  the player's tile, and would otherwise split one state per NPC step:
 *
 *  - between-fold transients are dropped exactly as a save snapshot drops
 *    them (cues, pending transfer/route/battle/placement queues);
 *  - pure progress is zeroed: the absolute frame counter, audio playback
 *    positions, and the mover's sub-tile interpolation (kept at tile level:
 *    tile + facing). None of these is read by a condition or a command's
 *    future — each recovers within a few ticks, and the save snapshot keeps
 *    the full values for pixel-exact restore;
 *  - every absolute time anchor is rebased onto the zeroed frame clock in
 *    the same pass (a fiber's `since`, a map animation's `start`), so two
 *    states parked at the same anchor but different elapsed time — same
 *    elapsed wait, different future — never share a key;
 *  - the held button mask is excluded: it is input state, not reducer state
 *    (callers that need edge continuity track it separately).
 *
 *  Unlike createSessionSnapshot this does not require a safe point: a
 *  world-idle state may sit mid-step, and the payload reads the live state
 *  read-only (shallow copies with fresh overridden fields), so hashing a
 *  state never mutates it. Everything the engine adds to InterpState later
 *  is included automatically — this is the engine's own snapshot shape, not
 *  a hand-picked field list. */
export function sessionStateFingerprint(state: SessionState): string {
  const interp: InterpState = { ...state.interp };
  normalizeInterpInPlace(interp);
  stripPlaybackClocksInPlace(interp);
  return fnv1aText(canonicalJson({
    map: state.mapId,
    player: tileLevelMovement(state.move),
    interp,
    ext: state.ext,
    ...(state.handoff ? { handoff: state.handoff } : {}),
  }));
}

// --- envelope ---------------------------------------------------------------

export interface SaveEnvelope {
  format: typeof SAVE_FORMAT;
  version: number;
  /** Frame clock of the snapshot (interp.frame), for the slot summary. */
  frame: number;
  /** FNV-1a 32-bit (8 hex chars) over canonical JSON of `state`. */
  checksum: string;
  /** Sharded-project build identity. Envelope metadata, not reducer state. */
  content?: MapContentIdentity;
  state: SaveSnapshot;
}

export type SaveErrorCode =
  | "bad-json"
  | "format"
  | "version"
  | "checksum"
  | "content"
  | "shape";

export class SaveError extends Error {
  constructor(
    readonly code: SaveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SaveError";
  }
}

// --- FNV-1a 32 over UTF-8 (same constants as hosts/sim/sim.ts fnv1a) -------

export function fnv1aBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function fnv1aText(s: string): string {
  return fnv1aBytes(utf8Encode(s));
}

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
      i++; // surrogate pair
    }
  }
  return new Uint8Array(out);
}

/** Canonical JSON: object keys sorted recursively (codepoint order), so the
 *  checksum does not depend on record insertion order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(stringifyCanonical(value));
}

function stringifyCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stringifyCanonical);
  if (value !== null && typeof value === "object") {
    const out = keyedRecord<unknown>();
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stringifyCanonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function encodeEnvelope(
  snapshot: SaveSnapshot,
  content?: MapContentIdentity | null,
): string {
  const state = cloneSnapshot(snapshot);
  const envelope: SaveEnvelope = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    frame: state.interp.frame,
    checksum: fnv1aText(canonicalJson(state)),
    ...(content ? { content: { ...content } } : {}),
    state,
  };
  return JSON.stringify(envelope);
}

// --- base64url save code ----------------------------------------------------

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INV: Record<string, number> = {};
for (let i = 0; i < B64URL.length; i++) B64URL_INV[B64URL[i]!] = i;

/** First characters of a compressed save code: "z" marks the compressed
 *  encoding (a plain code always starts "e") and "1" is its version, raw
 *  DEFLATE of the envelope's UTF-8 JSON. */
export const SAVE_CODE_COMPRESSED_PREFIX = "z1";

/** Largest envelope a save may hold, in UTF-8 bytes: a compressed code may
 *  not inflate past it, and longer envelope text is refused unparsed. */
export const SAVE_CODE_MAX_BYTES = 16_777_216; // 16 MiB

/** Longest save code accepted without whitespace: a plain code of a
 *  maximal envelope, ceil(SAVE_CODE_MAX_BYTES / 3) * 4 characters (written
 *  as a literal so bundles that never decode a code drop it). Pasted input
 *  may carry up to as much whitespace again. */
const SAVE_CODE_MAX_CHARS = 22_369_624;

/** Deepest array/object nesting a save may hold. Real saves nest about ten
 *  levels; decoding and validation walk the state recursively, so a small
 *  code inflating to a much deeper document would exhaust the call stack
 *  (QuickJS well before JSC). */
export const SAVE_MAX_DEPTH = 128;

/** Whether a snapshot, once wrapped in its envelope, nests arrays/objects
 *  deeper than SAVE_MAX_DEPTH. Iterative, so it is safe on any input. */
export function saveDepthExceeded(snapshot: unknown): boolean {
  // The envelope is level 1; the snapshot object sits at level 2.
  const stack: [unknown, number][] = [[snapshot, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (depth + 1 > SAVE_MAX_DEPTH) return true;
    const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return false;
}

/** The same bound read off JSON text before parsing it: brackets outside
 *  string literals. */
function textDepthExceeded(text: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // backslash: skip the escaped character
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b || c === 0x5b) {
      if (++depth > SAVE_MAX_DEPTH) return true;
    } else if (c === 0x7d || c === 0x5d) {
      depth--;
    }
  }
  return false;
}

/** Public decode boundary: every refusal is a SaveError. Anything else
 *  thrown while decoding untrusted input (a defect the checks above missed)
 *  is reported as unreadable data rather than escaping as a raw error. */
function typedDecode<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof SaveError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new SaveError("bad-json", `save data could not be decoded: ${reason}`);
  }
}

export interface SaveCodeOptions {
  /** DEFLATE the envelope before encoding (default true). False writes the
   *  plain code older runtimes read. */
  compress?: boolean;
}

/** URL-safe base64 without padding; whitespace tolerant on the way back.
 *  Compressed unless `options.compress` is false. */
export function encodeSaveCode(
  snapshot: SaveSnapshot,
  content?: MapContentIdentity | null,
  options: SaveCodeOptions = {},
): string {
  const bytes = utf8Encode(encodeEnvelope(snapshot, content));
  return options.compress === false
    ? base64UrlEncode(bytes)
    : SAVE_CODE_COMPRESSED_PREFIX + base64UrlEncode(deflateRaw(bytes));
}

function base64UrlEncode(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    parts.push(B64URL[b0 >> 2]!);
    parts.push(B64URL[((b0 & 3) << 4) | (b1 >> 4)]!);
    if (i + 1 < bytes.length) parts.push(B64URL[((b1 & 15) << 2) | (b2 >> 6)]!);
    if (i + 2 < bytes.length) parts.push(B64URL[b2 & 63]!);
  }
  return parts.join("");
}

function base64UrlDecode(clean: string): Uint8Array {
  if (clean.length % 4 === 1) throw new SaveError("bad-json", "save code has a truncated final group");
  const bytes = new Uint8Array(Math.floor(clean.length / 4) * 3 + Math.max(0, (clean.length % 4) - 1));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64URL_INV[clean[i]!];
    const c1 = B64URL_INV[clean[i + 1]!];
    const c2 = i + 2 < clean.length ? B64URL_INV[clean[i + 2]!] : 0;
    const c3 = i + 3 < clean.length ? B64URL_INV[clean[i + 3]!] : 0;
    if (c0 === undefined || c1 === undefined || c2 === undefined || c3 === undefined) {
      throw new SaveError("bad-json", "save code contains characters outside the save alphabet");
    }
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    bytes[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) bytes[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) bytes[o++] = n & 255;
  }
  return bytes;
}

/** Decode either save-code encoding (compressed "z1…" or plain). Every
 *  refusal is a SaveError. */
export function decodeSaveCode(
  code: string,
  expectedContent?: MapContentIdentity | null,
): SaveSnapshot {
  return typedDecode(() => decodeSaveCodeUnchecked(code, expectedContent));
}

function decodeSaveCodeUnchecked(
  code: string,
  expectedContent?: MapContentIdentity | null,
): SaveSnapshot {
  if (typeof code !== "string") throw new SaveError("bad-json", "save code must be a string");
  if (code.length > SAVE_CODE_MAX_CHARS * 2) {
    throw new SaveError("bad-json", `save code is longer than ${SAVE_CODE_MAX_CHARS * 2} characters`);
  }
  const clean = code.replace(/\s+/g, "");
  if (clean.length === 0) throw new SaveError("bad-json", "save code is empty");
  if (clean.length > SAVE_CODE_MAX_CHARS) {
    throw new SaveError("bad-json", `save code is longer than ${SAVE_CODE_MAX_CHARS} characters`);
  }
  let bytes: Uint8Array;
  if (clean[0] === "z") {
    if (!clean.startsWith(SAVE_CODE_COMPRESSED_PREFIX)) {
      throw new SaveError("version", `save code encoding ${JSON.stringify(clean.slice(0, 2))} is newer than this build reads`);
    }
    const packed = base64UrlDecode(clean.slice(SAVE_CODE_COMPRESSED_PREFIX.length));
    try {
      bytes = inflateRaw(packed, SAVE_CODE_MAX_BYTES);
    } catch (error) {
      if (!(error instanceof InflateError)) throw error;
      throw new SaveError("bad-json", `save code is damaged: ${error.message}`);
    }
  } else {
    bytes = base64UrlDecode(clean);
  }
  const text = utf8Decode(bytes);
  if (text === null) throw new SaveError("bad-json", "save code is not valid UTF-8");
  return decodeEnvelopeTextUnchecked(text, expectedContent);
}

/** Strict UTF-8 decode: validate lead/continuation bytes, overlong forms,
 *  surrogates and code points past U+10FFFF, so an alphabet-valid save code
 *  raises a typed SaveError instead of String.fromCodePoint's RangeError
 *  (F6/task-1173). Returns null on any malformed sequence. */
function utf8Decode(bytes: Uint8Array): string | null {
  let out = "";
  let i = 0;
  const cont = (at: number): number | null =>
    at < bytes.length ? (bytes[at]! & 0xc0) === 0x80 ? bytes[at]! & 0x3f : null : null;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let len: number;
    let min: number;
    if (b0 < 0x80) {
      out += String.fromCodePoint(b0);
      i += 1;
      continue;
    } else if (b0 >= 0xc2 && b0 < 0xe0) {
      len = 2; min = 0x80;
      const c1 = cont(i + 1);
      if (c1 === null) return null;
      cp = ((b0 & 0x1f) << 6) | c1;
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      len = 3; min = 0x800;
      const c1 = cont(i + 1);
      const c2 = cont(i + 2);
      if (c1 === null || c2 === null) return null;
      cp = ((b0 & 0x0f) << 12) | (c1 << 6) | c2;
    } else if (b0 >= 0xf0 && b0 < 0xf5) {
      len = 4; min = 0x10000;
      const c1 = cont(i + 1);
      const c2 = cont(i + 2);
      const c3 = cont(i + 3);
      if (c1 === null || c2 === null || c3 === null) return null;
      cp = ((b0 & 0x07) << 18) | (c1 << 12) | (c2 << 6) | c3;
    } else {
      return null; // 0x80..0xc1 (continuation/overlong-2), 0xf5+ (out of range)
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

// --- decode + validate ------------------------------------------------------

/** Decode and fully validate envelope JSON text. Every refusal is a
 *  SaveError. */
export function decodeEnvelopeText(
  text: string,
  expectedContent?: MapContentIdentity | null,
): SaveSnapshot {
  return typedDecode(() => decodeEnvelopeTextUnchecked(text, expectedContent));
}

function decodeEnvelopeTextUnchecked(
  text: string,
  expectedContent?: MapContentIdentity | null,
): SaveSnapshot {
  if (typeof text !== "string") throw new SaveError("bad-json", "save data must be text");
  if (!utf8BytesWithin(text, SAVE_CODE_MAX_BYTES)) {
    throw new SaveError("bad-json", `save data is larger than ${SAVE_CODE_MAX_BYTES} bytes`);
  }
  if (textDepthExceeded(text)) {
    throw new SaveError("bad-json", `save data nests deeper than ${SAVE_MAX_DEPTH} levels`);
  }
  let envelope: SaveEnvelope;
  try {
    envelope = JSON.parse(text) as SaveEnvelope;
  } catch {
    throw new SaveError("bad-json", "save data is not JSON");
  }
  if (envelope === null || typeof envelope !== "object") {
    throw new SaveError("shape", "save data has no envelope");
  }
  if (envelope.format !== SAVE_FORMAT) {
    throw new SaveError("format", `not a ${SAVE_FORMAT} save`);
  }
  if (envelope.version !== SAVE_VERSION) {
    throw new SaveError(
      "version",
      `save version ${String(envelope.version)} is not loadable by version ${SAVE_VERSION}`,
    );
  }
  if (envelope.content !== undefined && (
    envelope.content === null || typeof envelope.content !== "object" ||
    typeof envelope.content.manifest !== "string" ||
    typeof envelope.content.schema !== "string"
  )) {
    throw new SaveError("shape", "save content identity is malformed");
  }
  if (expectedContent) {
    if (!envelope.content) {
      throw new SaveError("content", "save has no content identity for this sharded project");
    }
    if (envelope.content.manifest !== expectedContent.manifest) {
      throw new SaveError("content", "save map manifest hash does not match this content build");
    }
    // A save from a listed, purely additive predecessor schema still loads;
    // it is rewritten under the current identity the next time it is saved.
    if (envelope.content.schema !== expectedContent.schema && !(
      expectedContent.schema === MAP_SCHEMA_HASH && isCompatibleMapSchemaHash(envelope.content.schema)
    )) {
      const why = expectedContent.schema === MAP_SCHEMA_HASH ? `: ${describeMapSchemaRefusal(envelope.content.schema)}` : "";
      throw new SaveError("content", `save map schema hash does not match this runtime${why}`);
    }
  }
  const snapshot = envelope.state;
  if (!isSnapshotShape(snapshot)) {
    throw new SaveError("shape", "save state is missing fields");
  }
  const expected = fnv1aText(canonicalJson(snapshot));
  if (typeof envelope.checksum !== "string" || envelope.checksum !== expected) {
    throw new SaveError("checksum", "save checksum mismatch (truncated or edited)");
  }
  // The event-model additions extended the existing v1 snapshot rather
  // than changing its envelope version. Hydrate only fields absent from an
  // older checksum-valid v1 save; an explicitly malformed value remains in
  // place for the deep validator to reject below.
  hydrateLegacyV1(snapshot);
  normalizeEmptyParallax(snapshot);
  // Checksum proved the bytes are intact, not that they form a legal
  // session: fully validate structure, ranges and save-time invariants
  // before anything can restore from this snapshot (F4/task-1173).
  const reason = validateSnapshot(snapshot);
  if (reason !== null) throw new SaveError("shape", `save state is invalid: ${reason}`);
  if (!envelopeConsistent(envelope as unknown as Record<string, unknown>, snapshot as unknown as Record<string, unknown>)) {
    throw new SaveError("shape", "save envelope frame does not match the state clock");
  }
  // JSON.parse returns ordinary objects. Re-clone before exposing the state
  // so legacy v1 saves keep the same wire bytes while every external-id
  // dictionary regains the runtime's null prototype.
  return cloneSnapshot(snapshot);
}

function hydrateLegacyV1(snapshot: SaveSnapshot): void {
  const interp = snapshot.interp as InterpState & {
    inputLocked?: boolean;
    placements?: InterpState["placements"];
    pendingPlacements?: InterpState["pendingPlacements"];
    pendingBattles?: InterpState["pendingBattles"];
    pendingBattle?: InterpState["pendingBattles"][number] | null;
  };
  if (interp.inputLocked === undefined) interp.inputLocked = false;
  if (interp.placements === undefined) interp.placements = keyedRecord();
  if (interp.pendingPlacements === undefined) interp.pendingPlacements = [];
  if (interp.pendingBattles === undefined) {
    interp.pendingBattles = interp.pendingBattle === undefined || interp.pendingBattle === null
      ? []
      : [interp.pendingBattle];
  }
  if ((snapshot as SaveSnapshot & { ext?: JsonValue }).ext === undefined) snapshot.ext = null;
}

/** The kit normalizes an empty parallax image name to "no parallax"
 *  everywhere a live state is built: createInterpState skips an authored
 *  empty name and changeParallax with "" clears a live one. This is a kit
 *  decision, not RPG Maker MV parity — MV keeps the empty name and keeps
 *  scrolling the hidden layer. A checksum-valid save may still carry the
 *  empty name (written by an older build, or hand-edited), so the decode
 *  path drops it too: after the checksum proved the bytes intact, before
 *  the deep validator runs, so a restored save matches the live paths and
 *  never accumulates phase for an image that can never render. */
function normalizeEmptyParallax(snapshot: SaveSnapshot): void {
  const parallax = (snapshot.interp as { parallax?: unknown }).parallax;
  if (isRecord(parallax) && parallax.image === "") {
    delete (snapshot.interp as { parallax?: unknown }).parallax;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Cheap presence/type pre-check so checksum parsing never indexes
 *  undefined; the deep validator (save-validate.ts) decides validity. */
function isSnapshotShape(v: unknown): v is SaveSnapshot {
  if (!isRecord(v)) return false;
  if (typeof v.map !== "string") return false;
  if (typeof v.held !== "number") return false;
  const player = v.player;
  if (!isRecord(player)) return false;
  for (const k of ["tx", "ty", "px", "py", "facing", "phase", "moving", "walking", "stepDir"]) {
    if (!(k in player)) return false;
  }
  const interp = v.interp;
  if (!isRecord(interp) || typeof interp.frame !== "number" || !isRecord(interp.sw)) return false;
  return true;
}

// --- slot helpers ------------------------------------------------------------

export function slotPath(slot: number): string {
  if (!Number.isInteger(slot) || slot < SLOT_MIN || slot > SLOT_MAX) {
    throw new Error(`save: slot ${String(slot)} out of range ${SLOT_MIN}..${SLOT_MAX}`);
  }
  return `save/slot-${slot}.json`;
}

export interface SlotSummary {
  slot: number;
  map: string;
  frame: number;
}

/** Parse a slot file for the menu summary. Unlike a bare JSON peek this
 *  runs the SAME full validation as a load (format/version/checksum/
 *  structural/frame consistency), so a bad file lists as an error instead
 *  of a healthy selectable slot (F5/task-1173). */
export function summarizeEnvelope(
  slot: number,
  text: string,
  expectedContent?: MapContentIdentity | null,
): SlotSummary & { checksum: string } {
  const snapshot = decodeEnvelopeText(text, expectedContent);
  const envelope = JSON.parse(text) as SaveEnvelope;
  return {
    slot,
    map: snapshot.map,
    frame: snapshot.interp.frame,
    checksum: envelope.checksum,
  };
}

/** A host-port-shaped store: the fs adapter (ui/save-fs.ts) implements it
 *  over @pocketjs/framework/fs; tests implement it over a Map. */
export interface SaveStore {
  exists(slot: number): boolean;
  read(slot: number): string | null;
  write(slot: number, envelope: string): void;
  remove?(slot: number): void;
}

export function saveToStore(
  store: SaveStore,
  slot: number,
  snapshot: SaveSnapshot,
  content?: MapContentIdentity | null,
): void {
  store.write(slot, encodeEnvelope(snapshot, content));
}

export function loadFromStore(
  store: SaveStore,
  slot: number,
  expectedContent?: MapContentIdentity | null,
): SaveSnapshot {
  const text = store.read(slot);
  if (text === null) throw new SaveError("bad-json", `slot ${slot} is empty`);
  return decodeEnvelopeText(text, expectedContent);
}
