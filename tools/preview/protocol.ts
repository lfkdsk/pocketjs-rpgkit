// tools/preview/protocol.ts — the rpgkit-preview/v1 message protocol.
//
// Pure TypeScript (no DOM): the same parsing, validation and dispatch runs
// in bun unit tests (tests/preview-protocol.test.ts) and in the browser host
// (tools/preview/preview.tsx). The wire is postMessage JSON; the reference
// frontend is tools/web/preview-demo.html and the reference documentation is
// docs/protocols.md, section "Preview protocol".

import type { Dir } from "../../src/engine/types.ts";
import { utf8BytesWithin, utf8UnitBytes } from "../../src/engine/utf8.ts";

export const PREVIEW_PROTOCOL = "rpgkit-preview/v1";
export const PREVIEW_VERSION = 1;

/** Bounds every host enforces before doing expensive work. A load over any
 *  bound is refused with `too-large`; see docs/protocols.md (Preview
 *  protocol, Limits). */
export const PREVIEW_LIMITS = {
  /** Whole wire message, counted structurally as an approximation of its
   *  JSON encoding (string UTF-8 bytes, 8 per number, 4 per boolean/null,
   *  plus container overhead). Checked before the message is parsed. */
  maxMessageBytes: 4 * 1024 * 1024,
  /** Chapters per `load`. */
  maxChapters: 64,
  /** One chapter snapshot (save code string or snapshot object), in bytes. */
  maxSnapshotBytes: 1024 * 1024,
  /** One chapter tape, in u16 frames. */
  maxChapterTapeLength: 36_000,
  /** A `requestId`, in UTF-8 bytes. */
  maxRequestIdBytes: 128,
  /** Images staged by `art` requests at once (complete or not). */
  maxArtImages: 1024,
  /** Raw RGBA bytes staged at once: the sum of width*height*4 over every
   *  staged image, counted when its first slice arrives. */
  maxArtBytes: 32 * 1024 * 1024,
  /** Longest side of one staged image, in pixels. */
  maxArtSide: 4096,
  /** An art image id, in UTF-8 bytes. */
  maxArtIdBytes: 256,
} as const;

/** Raw bytes a frontend puts in one `art` slice. Base64 inflates them by
 *  4/3, so a slice stays well under maxMessageBytes. A host accepts any
 *  slice size that fits the message budget. */
export const PREVIEW_ART_SLICE_BYTES = 2 * 1024 * 1024;

/** Optional capabilities a host lists in its `ready` event (`features`). A
 *  frontend uses a feature only when the host lists it; a host without the
 *  list (an older page) has none. */
export const PREVIEW_FEATURES = ["art"] as const;

export type PreviewErrorCode =
  | "bad-message"
  | "bad-version"
  | "not-loaded"
  | "bad-document"
  | "unknown-map"
  | "bad-start"
  | "unknown-chapter"
  | "bad-input"
  | "too-large"
  | "internal";

export class PreviewError extends Error {
  constructor(
    readonly code: PreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewError";
  }
}

// ---- results ----------------------------------------------------------------

export interface PreviewMapSummary {
  id: string;
  name: string;
  width: number;
  height: number;
}

/** An image a frontend supplied with `art` that the host could not use;
 *  the game keeps its stand-in for it. */
export interface PreviewArtSkip {
  kind: PreviewArtKind;
  id: string;
  reason: string;
}

/** What a `load` with `art: true` did with the staged images. */
export interface PreviewArtUse {
  /** Complete staged images the game now draws. */
  used: number;
  /** Complete staged images it could not use (incomplete ones are not
   *  listed: they were never part of the load). */
  skipped: PreviewArtSkip[];
}

export interface PreviewLoadResult {
  title: string;
  maps: PreviewMapSummary[];
  start: { map: string; x: number; y: number; dir: string };
  /** Present when the load asked for `art`; an optional addition within v1. */
  art?: PreviewArtUse;
  /** Text the preview baked for this document: `added` distinct characters
   *  beyond its built-in ones, and the `missing` characters it has no glyph
   *  for (shown as a missing-glyph box). Absent from hosts that predate it. */
  glyphs?: { added: number; missing: string };
}

/** What one image is: a tile sheet (also the source of item icon cells), a
 * sprite, a cooked animation sheet, or a map parallax. */
export type PreviewArtKind = "sheet" | "sprite" | "animation" | "parallax";

/** One validated `art` request: `bytes` land at byte `offset` of the
 *  image's width*height*4 RGBA8 buffer. */
export interface PreviewArtSlice {
  kind: PreviewArtKind;
  id: string;
  width: number;
  height: number;
  offset: number;
  bytes: Uint8Array;
  /** Cooked animation frame placement relative to its target tile. */
  offsetX?: number;
  offsetY?: number;
}

/** The reply to an `art` request. */
export interface PreviewArtResult {
  /** Bytes of this image received so far. */
  received: number;
  /** Whether every byte of this image has arrived. */
  complete: boolean;
  /** Images staged now, complete or not. */
  staged: number;
}

/** A complete staged image. */
export interface PreviewArtImage {
  kind: PreviewArtKind;
  id: string;
  width: number;
  height: number;
  rgba: Uint8Array;
  /** Cooked animation frame placement relative to its target tile. */
  offsetX?: number;
  offsetY?: number;
}

export type PreviewStartTarget =
  | { kind: "tile"; map: string; x: number; y: number; dir?: Dir }
  | { kind: "chapter"; chapter: string };

export interface PreviewStartResult {
  map: string;
  x: number;
  y: number;
  dir: string;
}

export interface PreviewMessage {
  kind: "text" | "scrollText" | "choices" | "shop";
  /** Whole dialogue or scrolling text (lines joined with "\n"), the choice
   *  prompt and options one per line, or "" for a shop. */
  text: string;
}

export interface PreviewStateResult {
  status: "running";
  map: string;
  x: number;
  y: number;
  px: number;
  py: number;
  dir: string;
  moving: boolean;
  // The next four fields are optional additions within v1: the preview host
  // always sends them, but a frontend must still accept a reply without them.
  /** Session frame counter; it advances once per simulated frame. */
  frame?: number;
  /** Event pages running now: the main one (if any) plus parallels. */
  running?: number;
  /** Key ("map/event") of the event page running in the main slot. */
  event?: string | null;
  /** The open message: dialogue, scrolling text, a choice prompt, or a shop. */
  message?: PreviewMessage | null;
  switches: Record<string, boolean>;
  variables: Record<string, number | string>;
  gold: number;
  items: Record<string, number>;
}

/** The host side of the protocol. The preview app implements it; tests use
 *  a fake. Every method either returns its result or throws PreviewError. */
export interface PreviewBackend {
  /** Validate and mount a project document (JSON text or an object). With
   *  `art`, the complete staged images replace stand-in art; either way the
   *  staging area is emptied. */
  load(document: unknown, chapters?: unknown, art?: boolean): PreviewLoadResult;
  /** Stage one slice of a project image for the next `load`. */
  art(slice: PreviewArtSlice): PreviewArtResult;
  /** Warp to a tile, or restore a chapter supplied with `load`. */
  start(target: PreviewStartTarget): PreviewStartResult;
  /** Read the running session's summary. */
  state(): PreviewStateResult;
  /** Hold a u16 button mask for `frames` host frames, then release. */
  input(buttons: number, frames: number): void;
  /** Unmount the current project and return to the idle screen. */
  stop(): void;
}

// ---- replies ----------------------------------------------------------------

export interface PreviewReply {
  protocol: typeof PREVIEW_PROTOCOL;
  type: "reply";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** What the host does with one received message:
 *  - a reply to post back to the sender;
 *  - "drop": the origin is not allowed, so no reply is sent;
 *  - null: handled, but no reply (fire-and-forget input/stop). */
export type PreviewDispatch = PreviewReply | "drop" | null;

// ---- origin allowlist --------------------------------------------------------

/** Origins the host accepts messages from. The page's own origin is always
 *  allowed (same-origin embeds); `?preview-origin=<origin>` query parameters
 *  (repeatable, comma-separated) add more. The opaque "null" origin (data:
 *  and file: pages) is never allowed: the player needs a real web origin. */
export function previewAllowlist(selfOrigin: string, search: string): Set<string> {
  const allow = new Set<string>();
  if (selfOrigin && selfOrigin !== "null") allow.add(selfOrigin);
  const query = new URLSearchParams(search);
  for (const raw of query.getAll("preview-origin")) {
    for (const piece of raw.split(",")) {
      const origin = piece.trim();
      if (origin && origin !== "null") allow.add(origin);
    }
  }
  return allow;
}

export function isAllowedOrigin(allow: ReadonlySet<string>, origin: string): boolean {
  return origin !== "null" && origin !== "" && allow.has(origin);
}

// ---- parsing -----------------------------------------------------------------

const DIRS: readonly Dir[] = ["down", "left", "up", "right"];
const MAX_INPUT_FRAMES = 600;

/** The most code units of a request value an error message quotes back. */
export const PREVIEW_ECHO_LIMIT = 64;

/** A short, bounded rendering of a request value for an error message: a
 *  string is quoted and cut to PREVIEW_ECHO_LIMIT code units (never through
 *  a surrogate pair) with a "(truncated)" marker; a number, boolean or null
 *  prints as itself; anything else is named by kind. The cost is bounded by
 *  the limit, whatever the size of `value`. */
export function echoPreviewValue(value: unknown): string {
  if (typeof value === "string") {
    if (value.length <= PREVIEW_ECHO_LIMIT) return JSON.stringify(value);
    let end = PREVIEW_ECHO_LIMIT;
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    return `${JSON.stringify(value.slice(0, end))}... (truncated, ${value.length} chars)`;
  }
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function asObject(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new PreviewError("bad-message", "message is not a JSON object");
  }
  return data as Record<string, unknown>;
}

// ---- byte budget --------------------------------------------------------------

/** Add the UTF-8 byte length of `s` one code unit at a time, so a budget
 *  callback can stop the walk partway through a long string. */
function walkStringBytes(s: string, add: (n: number) => void): void {
  for (let i = 0; i < s.length; i++) add(utf8UnitBytes(s, i));
}

/** Structural JSON size: string UTF-8 bytes, 8 per number, 4 per
 *  boolean/null, and container overhead (2 per bracket pair, 2 per array
 *  element, 4 per object entry plus its key's bytes). This approximates the
 *  JSON encoding without building it, so an over-budget message costs work
 *  proportional to the budget, not to the message. */
export function previewMessageBytes(value: unknown): number {
  let total = 0;
  walkPreviewBytes(value, (n) => {
    total += n;
  });
  return total;
}

/** Like previewMessageBytes, but throws `too-large` as soon as the running
 *  total passes `limit` — never walking the whole value when it is over. */
function assertWithinByteBudget(value: unknown, limit: number, label: string): void {
  let total = 0;
  walkPreviewBytes(value, (n) => {
    total += n;
    if (total > limit) throw new PreviewError("too-large", `${label} exceeds the ${limit}-byte budget`);
  });
}

/** Walk the structural JSON size of `value` piece by piece, calling `add`
 *  for each contribution. Strings are walked one code unit at a time, so a
 *  long string is scanned incrementally and the walk can be stopped from
 *  inside `add` (for example, the moment a byte budget is exceeded). */
export function walkPreviewBytes(value: unknown, add: (n: number) => void): void {
  if (value === null) {
    add(4);
    return;
  }
  switch (typeof value) {
    case "string":
      walkStringBytes(value, add);
      return;
    case "number":
      add(8);
      return;
    case "boolean":
      add(4);
      return;
    case "object":
      if (Array.isArray(value)) {
        add(2); // brackets
        for (const element of value) {
          add(2); // comma + element slot
          walkPreviewBytes(element, add);
        }
      } else {
        add(2); // braces
        for (const [key, element] of Object.entries(value as Record<string, unknown>)) {
          add(4); // "key":
          walkStringBytes(key, add);
          walkPreviewBytes(element, add);
        }
      }
      return;
    default:
      add(8); // undefined/function/symbol never survive the wire
  }
}

/** A present `requestId` must be a non-empty bounded string. Anything else
 *  refuses the message rather than demoting it to a notification, so a
 *  malformed caller can never smuggle work through the fire-and-forget
 *  path. */
function parseRequestId(msg: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(msg, "requestId")) return undefined;
  const id = msg.requestId;
  if (typeof id !== "string") throw new PreviewError("bad-message", "requestId must be a string");
  if (id.length === 0) throw new PreviewError("bad-message", "requestId must be a non-empty string");
  if (!utf8BytesWithin(id, PREVIEW_LIMITS.maxRequestIdBytes)) {
    throw new PreviewError("bad-message", `requestId must be at most ${PREVIEW_LIMITS.maxRequestIdBytes} bytes`);
  }
  return id;
}

/** Correlation key for an error reply: only a valid bounded string can be
 *  echoed back; a malformed id leaves the message silent (it never ran). */
function correlationId(data: unknown): string | undefined {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "requestId")) {
      const id = record.requestId;
      if (typeof id === "string" && id.length > 0 && utf8BytesWithin(id, PREVIEW_LIMITS.maxRequestIdBytes)) return id;
    }
  }
  return undefined;
}

function requireId(type: string, requestId: string | undefined): string {
  if (!requestId) throw new PreviewError("bad-message", `${type} needs a requestId`);
  return requestId;
}

/** Bounds for the optional chapter list, checked before the backend walks
 *  it. Shape errors stay where they are (the backend's chapterList), but
 *  count and size bounds belong to the wire. */
function checkChapterLimits(chapters: unknown): void {
  if (!Array.isArray(chapters)) return;
  if (chapters.length > PREVIEW_LIMITS.maxChapters) {
    throw new PreviewError("too-large", `a load accepts at most ${PREVIEW_LIMITS.maxChapters} chapters`);
  }
  chapters.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const chapter = entry as Record<string, unknown>;
    if (typeof chapter.snapshot === "string") {
      if (!utf8BytesWithin(chapter.snapshot, PREVIEW_LIMITS.maxSnapshotBytes)) {
        throw new PreviewError("too-large", `chapters[${index}].snapshot exceeds the ${PREVIEW_LIMITS.maxSnapshotBytes}-byte budget`);
      }
    } else if (chapter.snapshot && typeof chapter.snapshot === "object") {
      assertWithinByteBudget(chapter.snapshot, PREVIEW_LIMITS.maxSnapshotBytes, `chapters[${index}].snapshot`);
    }
    if (Array.isArray(chapter.tape) && chapter.tape.length > PREVIEW_LIMITS.maxChapterTapeLength) {
      throw new PreviewError("too-large", `chapters[${index}].tape exceeds the ${PREVIEW_LIMITS.maxChapterTapeLength}-frame budget`);
    }
  });
}

function parseStart(msg: Record<string, unknown>): PreviewStartTarget {
  if (typeof msg.chapter === "string") {
    if (msg.chapter.length === 0) throw new PreviewError("bad-message", "start chapter is empty");
    return { kind: "chapter", chapter: msg.chapter };
  }
  if (typeof msg.map !== "string" || msg.map.length === 0) {
    throw new PreviewError("bad-message", "start needs a map id and x/y, or a chapter id");
  }
  if (!Number.isInteger(msg.x) || (msg.x as number) < 0) {
    throw new PreviewError("bad-message", "start x must be a non-negative integer");
  }
  if (!Number.isInteger(msg.y) || (msg.y as number) < 0) {
    throw new PreviewError("bad-message", "start y must be a non-negative integer");
  }
  let dir: Dir | undefined;
  if (msg.dir !== undefined) {
    if (typeof msg.dir !== "string" || !(DIRS as readonly string[]).includes(msg.dir)) {
      throw new PreviewError("bad-message", `start dir must be one of ${DIRS.join(", ")}`);
    }
    dir = msg.dir as Dir;
  }
  return { kind: "tile", map: msg.map, x: msg.x as number, y: msg.y as number, dir };
}

// ---- art ----------------------------------------------------------------------

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64.length; i++) table[BASE64.charCodeAt(i)] = i;
  return table;
})();

/** Standard base64 (RFC 4648 alphabet, with `=` padding) of
 *  `bytes[start..end)`. */
export function encodePreviewBase64(bytes: Uint8Array, start = 0, end = bytes.length): string {
  const parts: string[] = [];
  let chunk = "";
  let i = start;
  for (; i + 3 <= end; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk += BASE64[n >> 18]! + BASE64[(n >> 12) & 63]! + BASE64[(n >> 6) & 63]! + BASE64[n & 63]!;
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  const rest = end - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    chunk += `${BASE64[n >> 18]!}${BASE64[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    chunk += `${BASE64[n >> 18]!}${BASE64[(n >> 12) & 63]!}${BASE64[(n >> 6) & 63]!}=`;
  }
  parts.push(chunk);
  return parts.join("");
}

/** Strict standard base64: a multiple of 4 characters from the RFC 4648
 *  alphabet, `=` only as the final one or two. Returns null for anything
 *  else (whitespace, the URL-safe alphabet, missing padding). */
export function decodePreviewBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  let pad = 0;
  if (text.endsWith("==")) pad = 2;
  else if (text.endsWith("=")) pad = 1;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length;
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const code = text.charCodeAt(i + k);
      let value: number;
      if (code === 61 /* = */ && last && k >= 4 - pad) value = 0;
      else value = code < 128 ? BASE64_VALUE[code]! : -1;
      if (value < 0) return null;
      n = (n << 6) | value;
    }
    out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Validate the fields of one `art` request (the wire message, or the same
 *  fields through the page's test hook). Size bounds are `too-large`, shape
 *  problems `bad-message`. */
export function parsePreviewArt(msg: Record<string, unknown>): PreviewArtSlice {
  const kind = msg.kind;
  if (kind !== "sheet" && kind !== "sprite" && kind !== "animation" && kind !== "parallax") {
    throw new PreviewError("bad-message", `art kind must be "sheet", "sprite", "animation" or "parallax", got ${echoPreviewValue(kind)}`);
  }
  const id = msg.id;
  if (typeof id !== "string" || id.length === 0) throw new PreviewError("bad-message", "art needs a non-empty id");
  if (!utf8BytesWithin(id, PREVIEW_LIMITS.maxArtIdBytes)) {
    throw new PreviewError("bad-message", `art id must be at most ${PREVIEW_LIMITS.maxArtIdBytes} bytes`);
  }
  for (const side of ["width", "height"] as const) {
    const value = msg[side];
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new PreviewError("bad-message", `art ${side} must be a positive integer, got ${echoPreviewValue(value)}`);
    }
    if ((value as number) > PREVIEW_LIMITS.maxArtSide) {
      throw new PreviewError("too-large", `art ${side} ${value as number} is over the ${PREVIEW_LIMITS.maxArtSide}-pixel limit`);
    }
  }
  const width = msg.width as number;
  const height = msg.height as number;
  const total = width * height * 4;
  if (total > PREVIEW_LIMITS.maxArtBytes) {
    throw new PreviewError("too-large", `art ${width}x${height} needs ${total} bytes; at most ${PREVIEW_LIMITS.maxArtBytes} are staged`);
  }
  const offset = msg.offset;
  if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) >= total) {
    throw new PreviewError("bad-message", `art offset must be an integer from 0 to ${total - 1}, got ${echoPreviewValue(offset)}`);
  }
  if (typeof msg.rgba !== "string" || msg.rgba.length === 0) {
    throw new PreviewError("bad-message", "art rgba must be a non-empty base64 string");
  }
  const bytes = decodePreviewBase64(msg.rgba);
  if (!bytes || bytes.length === 0) throw new PreviewError("bad-message", "art rgba is not valid base64");
  if ((offset as number) + bytes.length > total) {
    throw new PreviewError("bad-message", `art slice of ${bytes.length} bytes at offset ${offset as number} overflows the ${total}-byte image`);
  }
  const placement: { offsetX?: number; offsetY?: number } = {};
  for (const axis of ["offsetX", "offsetY"] as const) {
    const value = msg[axis];
    if (value === undefined) continue;
    if (kind !== "animation") throw new PreviewError("bad-message", `art ${axis} is only valid for an animation`);
    if (!Number.isSafeInteger(value) || Math.abs(value as number) > PREVIEW_LIMITS.maxArtSide) {
      throw new PreviewError("bad-message", `art ${axis} must be an integer from -${PREVIEW_LIMITS.maxArtSide} to ${PREVIEW_LIMITS.maxArtSide}, got ${echoPreviewValue(value)}`);
    }
    placement[axis] = value as number;
  }
  return { kind, id, width, height, offset: offset as number, bytes, ...placement };
}

interface StagedArt {
  image: PreviewArtImage;
  received: number;
}

/** The host's staging area for `art`: images by kind and id, filled slice
 *  by slice in order. A first slice (offset 0) starts the image afresh;
 *  every later slice must continue exactly where the previous one ended,
 *  with the same size and animation placement. `load` takes the complete
 *  images; `load` without art and `stop` discard everything. */
export class PreviewArtStage {
  private staged = new Map<string, StagedArt>();
  private bytes = 0;

  /** Images staged now, complete or not. */
  get size(): number {
    return this.staged.size;
  }

  /** Raw bytes reserved by the staged images. */
  get reserved(): number {
    return this.bytes;
  }

  add(slice: PreviewArtSlice): PreviewArtResult {
    const key = `${slice.kind}:${slice.id}`;
    const total = slice.width * slice.height * 4;
    let entry = this.staged.get(key);
    if (slice.offset === 0) {
      const freed = entry ? entry.image.rgba.length : 0;
      if (!entry && this.staged.size >= PREVIEW_LIMITS.maxArtImages) {
        throw new PreviewError("too-large", `at most ${PREVIEW_LIMITS.maxArtImages} images are staged at once`);
      }
      if (this.bytes - freed + total > PREVIEW_LIMITS.maxArtBytes) {
        throw new PreviewError("too-large", `staged art would need ${this.bytes - freed + total} bytes; at most ${PREVIEW_LIMITS.maxArtBytes} are staged`);
      }
      this.bytes -= freed;
      this.staged.delete(key);
      entry = {
        image: {
          kind: slice.kind,
          id: slice.id,
          width: slice.width,
          height: slice.height,
          rgba: new Uint8Array(total),
          ...(slice.offsetX === undefined ? {} : { offsetX: slice.offsetX }),
          ...(slice.offsetY === undefined ? {} : { offsetY: slice.offsetY }),
        },
        received: 0,
      };
      this.staged.set(key, entry);
      this.bytes += total;
    } else {
      if (!entry) {
        throw new PreviewError("bad-message", `art ${slice.kind} ${echoPreviewValue(slice.id)} has no first slice (offset 0) staged`);
      }
      if (entry.image.width !== slice.width || entry.image.height !== slice.height) {
        throw new PreviewError("bad-message", `art ${slice.kind} ${echoPreviewValue(slice.id)} was started at ${entry.image.width}x${entry.image.height}, not ${slice.width}x${slice.height}`);
      }
      if (entry.image.offsetX !== slice.offsetX || entry.image.offsetY !== slice.offsetY) {
        throw new PreviewError("bad-message", `art ${slice.kind} ${echoPreviewValue(slice.id)} changed its animation offsets between slices`);
      }
      if (slice.offset !== entry.received) {
        throw new PreviewError("bad-message", `art ${slice.kind} ${echoPreviewValue(slice.id)} expects its next slice at offset ${entry.received}, not ${slice.offset}`);
      }
    }
    entry.image.rgba.set(slice.bytes, slice.offset);
    entry.received = slice.offset + slice.bytes.length;
    return { received: entry.received, complete: entry.received === total, staged: this.staged.size };
  }

  /** The complete images, in staging order; empties the stage. */
  take(): PreviewArtImage[] {
    const complete: PreviewArtImage[] = [];
    for (const entry of this.staged.values()) {
      if (entry.received === entry.image.rgba.length) complete.push(entry.image);
    }
    this.clear();
    return complete;
  }

  clear(): void {
    this.staged.clear();
    this.bytes = 0;
  }
}

export interface PreviewRequest {
  type: "load" | "art" | "start" | "state" | "input" | "stop";
  requestId?: string;
  document?: unknown;
  chapters?: unknown;
  /** `load.art`: use the staged images. */
  useArt?: boolean;
  slice?: PreviewArtSlice;
  start?: PreviewStartTarget;
  buttons?: number;
  frames?: number;
}

/** Validate one wire message. Throws PreviewError on any shape problem. */
export function parsePreviewMessage(data: unknown): PreviewRequest {
  const msg = asObject(data);
  // The budget is checked before any field parsing or backend work, so an
  // allowed origin cannot force stringify/validation/traversal proportional
  // to an oversized message.
  assertWithinByteBudget(msg, PREVIEW_LIMITS.maxMessageBytes, "message");
  if (msg.protocol !== PREVIEW_PROTOCOL) {
    throw new PreviewError(
      "bad-version",
      `unsupported protocol ${echoPreviewValue(msg.protocol)}; expected "${PREVIEW_PROTOCOL}"`,
    );
  }
  if (typeof msg.type !== "string") throw new PreviewError("bad-message", "type is missing");
  const requestId = parseRequestId(msg);
  switch (msg.type) {
    case "load":
      if (msg.document === undefined) throw new PreviewError("bad-message", "load needs a document");
      if (msg.art !== undefined && typeof msg.art !== "boolean") throw new PreviewError("bad-message", "load art must be a boolean");
      checkChapterLimits(msg.chapters);
      return { type: "load", requestId: requireId("load", requestId), document: msg.document, chapters: msg.chapters, useArt: msg.art === true };
    case "art":
      return { type: "art", requestId: requireId("art", requestId), slice: parsePreviewArt(msg) };
    case "start":
      return { type: "start", requestId: requireId("start", requestId), start: parseStart(msg) };
    case "state":
      return { type: "state", requestId: requireId("state", requestId) };
    case "input": {
      if (!Number.isInteger(msg.buttons) || (msg.buttons as number) < 0 || (msg.buttons as number) > 0xffff) {
        throw new PreviewError("bad-input", "input buttons must be a u16 mask (0..65535)");
      }
      const frames = msg.frames ?? 1;
      if (!Number.isInteger(frames) || (frames as number) < 1 || (frames as number) > MAX_INPUT_FRAMES) {
        throw new PreviewError("bad-input", `input frames must be an integer from 1 through ${MAX_INPUT_FRAMES}`);
      }
      return { type: "input", requestId, buttons: msg.buttons as number, frames: frames as number };
    }
    case "stop":
      return { type: "stop", requestId };
    default:
      throw new PreviewError("bad-message", `unknown type ${echoPreviewValue(msg.type)}`);
  }
}

// ---- dispatch ----------------------------------------------------------------

function runBackend(backend: PreviewBackend, request: PreviewRequest): unknown {
  switch (request.type) {
    case "load":
      return backend.load(request.document, request.chapters, request.useArt);
    case "art":
      return backend.art(request.slice!);
    case "start":
      return backend.start(request.start!);
    case "state":
      return backend.state();
    case "input":
      backend.input(request.buttons!, request.frames!);
      return undefined;
    case "stop":
      backend.stop();
      return undefined;
  }
}

/** The single exit every reply leaves through. A candidate reply —
 *  success, parse error or backend error alike — is measured against the
 *  whole-message budget; one over it is replaced by a constant `too-large`
 *  error that carries only the (already bounded) requestId. */
function boundedReply(candidate: PreviewReply): PreviewReply {
  try {
    assertWithinByteBudget(candidate, PREVIEW_LIMITS.maxMessageBytes, "reply");
    return candidate;
  } catch (error) {
    // Measuring can only fail on budget, unless a result object misbehaves
    // (a throwing getter); either way the replacement is short and constant.
    const bounded =
      error instanceof PreviewError && error.code === "too-large"
        ? error
        : new PreviewError("internal", "reply could not be measured");
    return errorReply(candidate.requestId, bounded);
  }
}

function errorReply(requestId: string, error: unknown): PreviewReply {
  const pe =
    error instanceof PreviewError
      ? error
      : new PreviewError("internal", error instanceof Error ? error.message : String(error));
  return { protocol: PREVIEW_PROTOCOL, type: "reply", requestId, ok: false, error: { code: pe.code, message: pe.message } };
}

/** Validate, authorize and run one message against the backend. The caller
 *  posts a returned reply to `event.source` with `event.origin`; "drop" and
 *  null produce no reply. */
export function dispatchPreviewMessage(
  data: unknown,
  origin: string,
  allow: ReadonlySet<string>,
  backend: PreviewBackend,
): PreviewDispatch {
  if (!isAllowedOrigin(allow, origin)) return "drop";
  let request: PreviewRequest;
  try {
    request = parsePreviewMessage(data);
  } catch (error) {
    // A parse failure can still name a requestId; answer it so the frontend
    // does not have to time out to learn the message was malformed. A
    // malformed or absent id leaves the message silent (it never ran).
    const id = correlationId(data);
    if (!id) return null;
    return boundedReply(errorReply(id, error));
  }
  if (request.requestId === undefined) {
    // A notification has no reply channel; run it inside the same boundary
    // so a backend error stays contained and never reaches the browser's
    // event loop. Silent failure is the documented notification contract.
    try {
      runBackend(backend, request);
    } catch {
      // intentionally silent
    }
    return null;
  }
  let reply: PreviewReply;
  try {
    const result = runBackend(backend, request);
    reply =
      result === undefined
        ? { protocol: PREVIEW_PROTOCOL, type: "reply", requestId: request.requestId, ok: true }
        : { protocol: PREVIEW_PROTOCOL, type: "reply", requestId: request.requestId, ok: true, result };
  } catch (error) {
    reply = errorReply(request.requestId, error);
  }
  // Replies obey the same whole-message budget as requests: a backend result
  // or error message that would exceed it (for example a huge dialogue text
  // in a `state` reply) becomes a bounded `too-large` error instead.
  return boundedReply(reply);
}
