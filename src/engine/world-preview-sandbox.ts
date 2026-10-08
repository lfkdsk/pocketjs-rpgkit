// Neighbour character preview by sandboxed map entry.
//
// The static preview (world-preview.ts) shows only events whose map-entry
// snapshot it can prove without running anything, so content that places
// its characters from entry-time autorun/parallel pages (an importer's
// `create_npc`) previews nothing. The sandbox instead enters the neighbouring
// map in a private working state — the same `local.*` reset, page selection
// and entry-time autorun/parallel fibers as a real transfer, with `ext` calls
// going to the game's registered handlers — folds one reference tick, and
// reads the characters off the result. That tick is the first target tick:
// the frame on which the active actor pool first owns real characters after
// a seamless handoff, so a preview equal to it never jumps on takeover.
//
// The live session state is never written. Entry takes the interpreter state
// through the per-frame copy-on-write path (enterSessionMapIsolated), the
// sandbox session owns private derived caches and a repository that refuses
// every load and release (createSandboxSession), and every later tick goes
// through stepSession, which never mutates its input. Extension handlers are
// called with sandbox states, so they must be pure (as the reducer already
// requires). The game's preview hooks (previewKey, perturbExt) only ever see
// a private deep copy of the extension state, and entry copies the extension
// state it starts from (a perturbExt result included), so even a hook that
// writes its argument in place or returns a live object cannot reach the
// live state.
//
// A snapshot is only as good as its inputs. Entry may read what will differ
// when the player really crosses: where the player arrives and which way they
// face, the random cursor, and game state that moves on its own (a clock).
// The sandbox therefore runs the entry again under perturbed probes and
// rejects every event whose snapshot changes, plus a few static rules for
// reads a two-probe difference cannot see. Rejection is per event; only an
// entry that leaves, starts a scene, fails or branches on runtime-only state
// rejects the whole map.

import {
  compileSandboxMap,
  createSandboxSession,
  enterSessionMapIsolated,
  holdSandboxMap,
  isSessionWorldIdle,
  SandboxMapUnavailable,
  stepSession,
  trimSandboxMaps,
  type Session,
  type SessionInput,
  type SessionState,
} from "./session.ts";
import { deepClone, keyedRecord } from "./clone.ts";
import type { ExtensionReadContext } from "./extensions.ts";
import {
  activePage,
  effectiveEventAppearance,
  effectivePlayerAppearance,
  eventKey,
  type SwitchState,
} from "./interpreter.ts";
import { walkPose, type WalkPose } from "./movement.ts";
import { TILE } from "./tiles.ts";
import type {
  Command,
  CommonEvent,
  Condition,
  Facing,
  JsonValue,
  MapDef,
  PageCondition,
  SandboxPreviewRejectReason,
} from "./types.ts";
import { createWorldPreviewReader, type WorldMapPreview, type WorldPreviewReader } from "./world-preview.ts";

export type { SandboxPreviewRejectReason };

/** Every sandbox reject reason in report order (see the type for meaning).
 * An event collects every applicable reason and reports the first. */
export const SANDBOX_PREVIEW_REJECT_REASONS: readonly SandboxPreviewRejectReason[] = [
  "duplicate-id",
  "entry-transfer",
  "entry-scene",
  "entry-error",
  "entry-runtime-branch",
  "facing-condition",
  "runtime-condition",
  "player-dependent",
  "random-dependent",
  "volatile-dependent",
];

/** One character as the snapshot tick paints it (map-local pixels). */
export interface SandboxActor {
  eventId: string;
  pageIndex: number;
  tx: number;
  ty: number;
  px: number;
  py: number;
  facing: Facing;
  pose: WalkPose;
  sprite: string;
  /** 0–255, as the appearance state stores it. */
  opacity: number;
}

/** Game hooks for the sandbox. Both see a private deep copy of the decoded
 * extension state (writing it changes nothing else); entry copies a
 * perturbExt result before using it. */
export interface SandboxPreviewHooks {
  /** Everything a map entry can observe of the extension state, at the
   * granularity its conditions read it (a clock as day + hour when conditions
   * test the hour), as a value compared with Object.is (a string or number).
   * Leave out only what changes on its own every step and does not decide who
   * stands where on entry (step counters), and finer state no condition
   * reads. Default: the state itself when it is a primitive, else its JSON
   * text. */
  previewKey?(ext: JsonValue): unknown;
  /** The extension state with the parts `previewKey` leaves out moved (the
   * minute within the hour). Adds the `volatile-dependent` probe. One moved
   * value cannot show that a condition ignores the state, since the condition
   * may agree on both values, so readable state belongs in the key. */
  perturbExt?(ext: JsonValue): JsonValue;
}

export interface SandboxProbe {
  /** Player cell and facing for the sandboxed entry (map-local; may be off
   * the map, which keeps the player out of every character's way). */
  x: number;
  y: number;
  facing: Facing;
  /** XOR applied to the switch bank's random cursor before entry. */
  rngSalt?: number;
  /** Replace the extension state before entry. */
  perturbExt?: (ext: JsonValue) => JsonValue;
}

export type SandboxOutcome = "ok" | "entry-transfer" | "entry-scene" | "entry-error";

export interface SandboxRun {
  outcome: SandboxOutcome;
  /** Reference ticks actually folded. */
  ticks: number;
  /** Painted characters after `ticks`, in authored event order (empty when
   * the entry transferred away). */
  actors: SandboxActor[];
  /** The message of an exception thrown by the entry (outcome entry-error). */
  error?: string;
}

export interface SandboxRunOptions {
  /** Ticks folded before the snapshot (default 1: the first target tick). */
  ticks?: number;
}

const IDLE: SessionInput = { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

const FACING_OF_DIR = { down: 0, left: 1, up: 2, right: 3 } as const;

/** Characters `s` paints on its active map, in authored event order, by the
 * actor pool's rules after a seamless commit: a runtime character as it
 * stands, and an event without one yet (its page started holding after this
 * tick's page sync) on its active page at its durable placement or authored
 * cell, idle, facing the placement or page direction. */
export function sandboxActors(sess: Session, s: Readonly<SessionState>): SandboxActor[] {
  const map = sess.maps.get(s.mapId)!;
  const out: SandboxActor[] = [];
  for (const ev of map.events ?? []) {
    const ch = s.chars.chars[ev.id];
    if (ch) {
      if (!ch.visible) continue;
      const appearance = effectiveEventAppearance(
        { pageIndex: ch.pageIndex, sprite: ev.pages[ch.pageIndex]?.sprite ?? null },
        s.interp.eventAppearances?.[ev.id],
      );
      if (!appearance.visible || appearance.sprite === null) continue;
      out.push({
        eventId: ev.id,
        pageIndex: ch.pageIndex,
        tx: ch.tx,
        ty: ch.ty,
        px: ch.px,
        py: ch.py,
        facing: ch.facing,
        pose: walkPose(ch.phase),
        sprite: appearance.sprite,
        opacity: appearance.opacity,
      });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(s.interp.erased, eventKey(s.mapId, ev.id))) continue;
    const active = activePage(ev, s.sw, s.mapId, s.move.facing, {
      runtime: sess.extensions,
      ext: s.ext,
    }, { worldIdle: isSessionWorldIdle(s as SessionState) });
    const appearance = effectiveEventAppearance(
      { pageIndex: active?.index ?? -1, sprite: active?.page.sprite ?? null },
      s.interp.eventAppearances?.[ev.id],
    );
    if (!appearance.visible || appearance.sprite === null) continue;
    const placed = s.interp.placements[ev.id];
    const x = placed ? placed.x : ev.x;
    const y = placed ? placed.y : ev.y;
    const dir = placed?.dir ?? active?.page.dir;
    out.push({
      eventId: ev.id,
      pageIndex: active?.index ?? -1,
      tx: x,
      ty: y,
      px: x * TILE,
      py: y * TILE,
      facing: dir ? FACING_OF_DIR[dir] : 0,
      pose: 0,
      sprite: appearance.sprite,
      opacity: appearance.opacity,
    });
  }
  return out;
}

function outcomeOf(s: Readonly<SessionState>, mapId: string): SandboxOutcome {
  if (s.interp.error) return "entry-error";
  if (s.mapId !== mapId || s.handoff !== undefined || s.fade !== null || s.interp.pendingTransfer) {
    return "entry-transfer";
  }
  if (s.scene !== null || s.interp.pendingBattles.length > 0 || (s.interp.pendingScenes?.length ?? 0) > 0) {
    return "entry-scene";
  }
  return "ok";
}

export function sameSandboxActor(a: SandboxActor, b: SandboxActor): boolean {
  return a.eventId === b.eventId && a.pageIndex === b.pageIndex && a.tx === b.tx && a.ty === b.ty &&
    a.px === b.px && a.py === b.py && a.facing === b.facing && a.pose === b.pose &&
    a.sprite === b.sprite && a.opacity === b.opacity;
}

/** A copy of the extension state no hook can write through to the live one. */
function privateExt(ext: JsonValue): JsonValue {
  return ext === null || typeof ext !== "object" ? ext : deepClone(ext);
}

function probeSource(live: Readonly<SessionState>, probe: SandboxProbe): Readonly<SessionState> {
  if (probe.rngSalt === undefined && !probe.perturbExt) return live;
  const sw = probe.rngSalt !== undefined ? { ...live.sw, rng: (live.sw.rng ^ probe.rngSalt) >>> 0 } : live.sw;
  return {
    ...live,
    sw,
    interp: { ...live.interp, sw },
    // The hook gets a copy, so an in-place write cannot reach `live`; entry
    // copies (and validates) whatever it returns.
    ext: probe.perturbExt ? probe.perturbExt(privateExt(live.ext)) : live.ext,
  };
}

/** Enter `mapId` from `live`'s durable state inside `sandbox` (a session
 * from createSandboxSession holding the map) and fold `ticks` idle reference
 * ticks. An exception inside the sandbox never reaches the caller: reaching
 * for a map the sandbox does not hold is a transfer, anything else an
 * error. */
export function runSandboxEntry(
  sandbox: Session,
  live: Readonly<SessionState>,
  mapId: string,
  probe: SandboxProbe,
  options: SandboxRunOptions = {},
): SandboxRun {
  const ticks = options.ticks ?? 1;
  let folded = 0;
  try {
    let s = enterSessionMapIsolated(sandbox, probeSource(live, probe), mapId, probe.x, probe.y, probe.facing);
    let outcome: SandboxOutcome = "ok";
    while (folded < ticks) {
      s = stepSession(sandbox, s, IDLE);
      folded++;
      outcome = outcomeOf(s, mapId);
      if (outcome !== "ok") break;
    }
    return { outcome, ticks: folded, actors: outcome === "entry-transfer" ? [] : sandboxActors(sandbox, s) };
  } catch (error) {
    if (error instanceof SandboxMapUnavailable && error.mapId !== mapId) {
      return { outcome: "entry-transfer", ticks: folded + 1, actors: [] };
    }
    return {
      outcome: "entry-error",
      ticks: folded,
      actors: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// --- static rules for reads two probes cannot vary --------------------------

type RuntimeKind = "facing" | "runtime";

function conditionKind(c: Condition): RuntimeKind | null {
  if (c.kind === "facing") return "facing";
  if (c.kind === "timer" || c.kind === "bgmPlaying") return "runtime";
  return null;
}

/** Bit 1: a clause reads the facing; bit 2: the timer or BGM. */
function pageConditionKinds(condition: PageCondition | undefined): number {
  let bits = 0;
  for (const clause of condition?.all ?? []) {
    const kind = conditionKind(clause);
    if (kind === "facing") bits |= 1;
    else if (kind === "runtime") bits |= 2;
  }
  return bits;
}

function programBranchesOnRuntime(
  commands: readonly Command[],
  common: ReadonlyMap<string, CommonEvent>,
  visiting: Set<string>,
): boolean {
  for (const command of commands) {
    switch (command.op) {
      case "if":
        if (conditionKind(command.if) !== null) return true;
        if (programBranchesOnRuntime(command.then, common, visiting)) return true;
        if (command.else && programBranchesOnRuntime(command.else, common, visiting)) return true;
        break;
      case "choices":
        for (const option of command.options) {
          if (programBranchesOnRuntime(option.commands, common, visiting)) return true;
        }
        if (command.cancel && programBranchesOnRuntime(command.cancel.commands, common, visiting)) return true;
        break;
      case "loop":
        if (programBranchesOnRuntime(command.commands, common, visiting)) return true;
        break;
      case "common": {
        const called = common.get(command.id);
        if (!called || visiting.has(called.id)) break;
        visiting.add(called.id);
        const hit = programBranchesOnRuntime(called.commands, common, visiting);
        visiting.delete(called.id);
        if (hit) return true;
        break;
      }
      default:
        break;
    }
  }
  return false;
}

interface StaticRules {
  duplicate: ReadonlySet<string>;
  /** Per event id: page index → pageConditionKinds bits. */
  pageKinds: ReadonlyMap<string, readonly number[]>;
  entryBranch: boolean;
}

const staticRules = /* @__PURE__ */ new WeakMap<MapDef, Map<readonly CommonEvent[], StaticRules>>();

function rulesOf(map: Readonly<MapDef>, commonEvents: readonly CommonEvent[]): StaticRules {
  let byCommon = staticRules.get(map as MapDef);
  const hit = byCommon?.get(commonEvents);
  if (hit) return hit;
  const counts = new Map<string, number>();
  for (const ev of map.events ?? []) counts.set(ev.id, (counts.get(ev.id) ?? 0) + 1);
  const common = new Map(commonEvents.map((event) => [event.id, event] as const));
  const pageKinds = new Map<string, number[]>();
  let entryBranch = false;
  for (const ev of map.events ?? []) {
    pageKinds.set(ev.id, ev.pages.map((page) => pageConditionKinds(page.condition)));
    for (const page of ev.pages) {
      if ((page.trigger === "autorun" || page.trigger === "parallel") &&
          programBranchesOnRuntime(page.commands, common, new Set())) {
        entryBranch = true;
      }
    }
  }
  const rules: StaticRules = {
    duplicate: new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id)),
    pageKinds,
    entryBranch,
  };
  if (!byCommon) {
    byCommon = new Map();
    staticRules.set(map as MapDef, byCommon);
  }
  byCommon.set(commonEvents, rules);
  return rules;
}

// --- the preview -------------------------------------------------------------

export interface SandboxRejection {
  eventId: string;
  reason: SandboxPreviewRejectReason;
}

/** A previewed character. `fallback` marks one the sandbox rejected but the
 * static preview proves for the map-entry frame (painted at its authored
 * cell, never handed over on a commit frame). */
export interface SandboxPreviewActor extends SandboxActor {
  fallback?: true;
}

export interface SandboxMapPreview {
  mapId: string;
  /** Previewed characters in authored event order (sandbox actors), then
   * static fallbacks in event-id order. */
  actors: readonly SandboxPreviewActor[];
  /** Events that paint in some probe run but are not previewed. */
  rejected: readonly SandboxRejection[];
  /** Events that paint in no probe run. */
  hidden: number;
  /** Every authored event on the map: actors + rejected + hidden. */
  events: number;
  /** Map-wide outcome of the base run. */
  outcome: SandboxOutcome;
}

export interface SandboxPreviewOptions extends SandboxPreviewHooks {
  commonEvents?: readonly CommonEvent[];
  /** The base probe; default: the player 16 tiles beyond the map's
   * top-left corner, facing down. */
  base?: SandboxProbe;
  /** Replace the default differential probes. Each is tagged with the
   * reason an event gets when its snapshot differs from the base run. */
  probes?: readonly SandboxTaggedProbe[];
  /** When given, events the sandbox rejects but this static preview of the
   * same durable state shows are previewed from it (`fallback`). */
  fallback?: WorldMapPreview;
  /** Snapshot tick (default 1). Diagnostics only: later ticks are not what
   * a handoff first shows. */
  ticks?: number;
}

export interface SandboxTaggedProbe {
  reason: SandboxPreviewRejectReason;
  probe: SandboxProbe;
}

const FAR = 16;

/** The base probe and the differential probes for `map`: the player off the
 * map (so it never blocks, touches or is approached by a character) beyond
 * two opposite corners with opposite facings, the random cursor salted, and
 * — when the game supplies `perturbExt` — its volatile state moved. */
export function defaultSandboxProbes(
  map: Readonly<MapDef>,
  options: SandboxPreviewOptions = {},
): { base: SandboxProbe; probes: SandboxTaggedProbe[] } {
  const base = options.base ?? { x: -FAR, y: -FAR, facing: 0 as Facing };
  const probes: SandboxTaggedProbe[] = options.probes ? [...options.probes] : [
    { reason: "player-dependent", probe: { x: map.width + FAR, y: map.height + FAR, facing: 2 as Facing } },
    { reason: "random-dependent", probe: { ...base, rngSalt: 0x9e37_79b9 } },
  ];
  if (options.perturbExt) probes.push({ reason: "volatile-dependent", probe: { ...base, perturbExt: options.perturbExt } });
  return { base, probes };
}


/** Combine the base run and the probe runs into the preview. Every event
 * that paints in some run and is not identical across runs (or hits a static
 * rule) is rejected with the first applicable reason; events painting in no
 * run are hidden. */
export function assembleSandboxPreview(
  map: Readonly<MapDef>,
  commonEvents: readonly CommonEvent[],
  baseRun: SandboxRun,
  runs: readonly { reason: SandboxPreviewRejectReason; run: SandboxRun }[],
  fallback?: WorldMapPreview,
): SandboxMapPreview {
  const rules = rulesOf(map, commonEvents);
  const events = map.events ?? [];
  const actors: SandboxPreviewActor[] = [];
  const rejected: SandboxRejection[] = [];
  let hidden = 0;
  const masks = new Map<string, number>();
  if (baseRun.outcome !== "ok") {
    // The whole map is unprovable; every event that could paint is rejected.
    const bit = 1 << SANDBOX_PREVIEW_REJECT_REASONS.indexOf(baseRun.outcome as SandboxPreviewRejectReason);
    for (const ev of events) {
      if (ev.pages.some((page) => page.sprite !== null && page.sprite !== undefined)) {
        masks.set(ev.id, bit | (rules.duplicate.has(ev.id) ? 1 : 0));
      } else hidden++;
    }
  } else {
    const baseById = new Map(baseRun.actors.map((actor) => [actor.eventId, actor] as const));
    const probeById = runs.map(({ reason, run }) => ({
      bit: 1 << SANDBOX_PREVIEW_REJECT_REASONS.indexOf(reason),
      run,
      byId: new Map(run.actors.map((actor) => [actor.eventId, actor] as const)),
    }));
    for (const ev of events) {
      let mask = 0;
      const mine = baseById.get(ev.id);
      let paints = mine !== undefined;
      for (const probe of probeById) {
        if (probe.run.outcome !== "ok") {
          mask |= probe.bit;
          continue;
        }
        const other = probe.byId.get(ev.id);
        if (other) paints = true;
        if ((mine === undefined) !== (other === undefined) || (mine && other && !sameSandboxActor(mine, other))) {
          mask |= probe.bit;
        }
      }
      if (!paints) {
        hidden++;
        continue;
      }
      if (rules.duplicate.has(ev.id)) mask |= 1 << 0;
      if (rules.entryBranch) mask |= 1 << 4;
      const kinds = rules.pageKinds.get(ev.id)!;
      for (let i = mine?.pageIndex ?? 0; i < kinds.length; i++) {
        if (kinds[i]! & 1) mask |= 1 << 5;
        if (kinds[i]! & 2) mask |= 1 << 6;
      }
      if (mask !== 0) masks.set(ev.id, mask);
      else if (mine) actors.push(mine);
    }
  }
  const fallbackById = fallback && masks.size > 0
    ? new Map(fallback.actors.map((actor) => [actor.eventId, actor] as const))
    : undefined;
  // One entry per authored event, so actors + rejected + hidden = events
  // (both copies of a duplicated id are rejected, never shown as fallback).
  for (const ev of events) {
    const mask = masks.get(ev.id);
    if (mask === undefined) continue;
    const proven = rules.duplicate.has(ev.id) ? undefined : fallbackById?.get(ev.id);
    if (proven) {
      actors.push({
        eventId: proven.eventId,
        pageIndex: proven.pageIndex,
        tx: proven.x,
        ty: proven.y,
        px: proven.x * TILE,
        py: proven.y * TILE,
        facing: FACING_OF_DIR[proven.dir],
        pose: 0,
        sprite: proven.sprite,
        opacity: 255,
        fallback: true,
      });
      continue;
    }
    rejected.push({ eventId: ev.id, reason: SANDBOX_PREVIEW_REJECT_REASONS[31 - Math.clz32(mask & -mask)]! });
  }
  return { mapId: map.id, actors, rejected, hidden, events: events.length, outcome: baseRun.outcome };
}

/** The complete sandbox preview of `mapId` for the live durable state, in
 * one call: the base run, then every differential probe. `sandbox` must hold
 * the map (holdSandboxMap). For coverage reports and tests; a renderer uses
 * createSandboxPreviewReader, which spreads the same work over frames. */
export function sandboxWorldMapPreview(
  sandbox: Session,
  live: Readonly<SessionState>,
  mapId: string,
  options: SandboxPreviewOptions = {},
): SandboxMapPreview {
  const map = sandbox.maps.get(mapId);
  if (!map) throw new Error(`sandbox preview: map ${mapId} is not held by the sandbox`);
  const { base, probes } = defaultSandboxProbes(map, options);
  const commonEvents = options.commonEvents ?? sandbox.commonEvents;
  const run = { ticks: options.ticks ?? 1 };
  const baseRun = runSandboxEntry(sandbox, live, mapId, base, run);
  const runs = baseRun.outcome !== "ok"
    ? []
    : probes.map(({ reason, probe }) => ({ reason, run: runSandboxEntry(sandbox, live, mapId, probe, run) }));
  return assembleSandboxPreview(map, commonEvents, baseRun, runs, options.fallback);
}

export interface SandboxPreviewCoverage {
  maps: number;
  events: number;
  previewed: number;
  /** Of `previewed`, characters shown from the static fallback. */
  fallback: number;
  hidden: number;
  rejected: number;
  /** Count per reason; every reason is present (zero when unused). */
  reasons: Record<SandboxPreviewRejectReason, number>;
}

export function summarizeSandboxPreviewCoverage(previews: readonly SandboxMapPreview[]): SandboxPreviewCoverage {
  const reasons = keyedRecord<number>() as Record<SandboxPreviewRejectReason, number>;
  for (const reason of SANDBOX_PREVIEW_REJECT_REASONS) reasons[reason] = 0;
  const out: SandboxPreviewCoverage = { maps: previews.length, events: 0, previewed: 0, fallback: 0, hidden: 0, rejected: 0, reasons };
  for (const preview of previews) {
    out.events += preview.events;
    out.previewed += preview.actors.length;
    for (const actor of preview.actors) if (actor.fallback) out.fallback++;
    out.hidden += preview.hidden;
    out.rejected += preview.rejected.length;
    for (const entry of preview.rejected) reasons[entry.reason]++;
  }
  return out;
}

// --- cache and frame scheduling ------------------------------------------------

function isLocal(id: string): boolean {
  return id.startsWith("local.");
}

/** Equal ignoring per-visit `local.*` ids, which every entry clears. */
function sameDurableRecord(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  if (a === b) return true;
  for (const id in a) {
    if (!isLocal(id) && a[id] !== b[id]) return false;
  }
  for (const id in b) {
    if (!isLocal(id) && b[id] !== undefined && !Object.prototype.hasOwnProperty.call(a, id)) return false;
  }
  return true;
}

function defaultPreviewKey(ext: JsonValue): unknown {
  return ext === null || typeof ext !== "object" ? ext : JSON.stringify(ext);
}

type SwitchField = keyof SwitchState;

/** How the reader's durable fingerprint covers each field an extension
 * condition can read (ExtensionReadContext): a `record` or `value` field is
 * the switch-bank field of the same name, compared by identity and then by
 * value without `local.*`, or with Object.is; `ext` goes through the game's
 * previewKey; `project` is immutable project data. The type spans every
 * context field, so a new one does not compile until it is stamped here. */
export const SANDBOX_PREVIEW_STAMPED_CONTEXT: {
  readonly [K in keyof Required<ExtensionReadContext>]: K extends SwitchField
    ? NonNullable<SwitchState[K]> extends object ? "record" : "value"
    : "ext" | "project";
} = {
  ext: "ext",
  switches: "record",
  variables: "record",
  items: "record",
  gold: "value",
  playerName: "value",
  playerAppearance: "record",
  itemCatalog: "project",
};

function stampedFields(kind: "record" | "value"): SwitchField[] {
  const out: SwitchField[] = [];
  for (const [field, stamped] of Object.entries(SANDBOX_PREVIEW_STAMPED_CONTEXT)) {
    if (stamped === kind) out.push(field as SwitchField);
  }
  return out;
}

/** Switch-bank records in the fingerprint: the context's, plus self
 * switches (page and `if` conditions read them). */
const STAMPED_RECORDS: readonly SwitchField[] = [...stampedFields("record"), "self"];
const STAMPED_VALUES: readonly SwitchField[] = stampedFields("value");

/** The durable inputs of a map entry, as last observed. The random cursor
 * and the timer are left out on purpose (the probes and static rules reject
 * what reads them), and so is everything per visit. */
interface DurableStamp {
  /** By STAMPED_RECORDS index; null before the first observation. */
  records: (Readonly<Record<string, unknown>> | null)[];
  /** By STAMPED_VALUES index. */
  values: unknown[];
  appearance: string | null;
  ext: JsonValue | undefined;
  extKey: unknown;
}

export interface SandboxPreviewReaderOptions extends SandboxPreviewHooks {
  /** The project's common events (default: the live session's). */
  commonEvents?: readonly CommonEvent[];
  /** Sandbox work units per pump (default 1). A unit is one probe entry or
   * one slice of compiling a map the live session holds only parsed
   * (compileSandboxMap: bounded World slices, then the passage table). */
  unitsPerPump?: number;
  /** Fall back to the static preview for events the sandbox rejects, and
   * while a map has no sandbox preview yet (default true). */
  staticFallback?: boolean;
}

export interface SandboxPreviewReaderStats {
  /** Durable-state changes observed (each invalidates every cached map). */
  invalidations: number;
  /** Work units run, split by kind. */
  probes: number;
  compiles: number;
  /** Previews completed, and jobs restarted because state changed mid-way. */
  completed: number;
  restarted: number;
  /** Maps waiting for (re)computation, including the one in progress. */
  pending: number;
}

/** A cached, frame-scheduled sandbox preview for presentation code that
 * reads the same neighbour maps frame after frame.
 *
 * - `observe(state)` once per frame: compares the durable entry inputs with
 *   the last frame's (by record identity first, by value ignoring `local.*`
 *   when an identity changed) and the game's `previewKey`. Any change
 *   invalidates every cached preview. No allocation on the unchanged path.
 * - `read(map)` returns the cached preview — kept, possibly stale, until its
 *   replacement is complete — and queues the map when it is missing or
 *   stale. With `staticFallback`, a map with no sandbox preview yet reads
 *   as undefined and the caller paints the static preview.
 * - `pump()` runs at most `unitsPerPump` units of queued work against the
 *   state observed when the job started; a durable change restarts the job.
 *   A full preview is 1 base run + 2–3 probe runs (+2 or more compile units
 *   for a map the live session holds parsed only), so a map refreshes over 3–6
 *   frames.
 * - `retain(mapIds)` drops cached previews, queued work and sandbox-held
 *   maps outside the set. */
export interface SandboxPreviewReader {
  observe(state: Readonly<SessionState>): void;
  read(map: Readonly<MapDef>): SandboxMapPreview | undefined;
  /** Returns true when a cached preview was replaced. */
  pump(): boolean;
  retain(mapIds: Iterable<string>): void;
  readonly stats: Readonly<SandboxPreviewReaderStats>;
}

interface CacheEntry {
  map: Readonly<MapDef>;
  generation: number;
  preview: SandboxMapPreview;
}

interface Job {
  map: Readonly<MapDef>;
  generation: number;
  state: Readonly<SessionState>;
  compiled: boolean;
  base?: SandboxRun;
  runs: { reason: SandboxPreviewRejectReason; run: SandboxRun }[];
  probes: SandboxTaggedProbe[];
  baseProbe: SandboxProbe;
}

export function createSandboxPreviewReader(
  live: Session,
  options: SandboxPreviewReaderOptions = {},
): SandboxPreviewReader {
  const sandbox = createSandboxSession(live);
  const commonEvents = options.commonEvents ?? live.commonEvents;
  const gamePreviewKey = options.previewKey;
  const previewKey = gamePreviewKey ? (ext: JsonValue) => gamePreviewKey(privateExt(ext)) : defaultPreviewKey;
  const unitsPerPump = Math.max(1, options.unitsPerPump ?? 1);
  const staticReader: WorldPreviewReader | undefined = options.staticFallback === false
    ? undefined
    : createWorldPreviewReader({ commonEvents });
  const cache = new Map<string, CacheEntry>();
  const queue: string[] = [];
  let job: Job | undefined;
  let generation = 0;
  let state: Readonly<SessionState> | undefined;
  const stamp: DurableStamp = {
    records: STAMPED_RECORDS.map(() => null),
    values: STAMPED_VALUES.map(() => undefined),
    appearance: null,
    ext: undefined,
    extKey: undefined,
  };
  const stats: SandboxPreviewReaderStats = {
    invalidations: 0,
    probes: 0,
    compiles: 0,
    completed: 0,
    restarted: 0,
    pending: 0,
  };

  const durableChanged = (sw: Readonly<SwitchState>, ext: JsonValue): boolean => {
    let changed = false;
    for (let i = 0; i < STAMPED_RECORDS.length; i++) {
      const was = stamp.records[i]!;
      // playerAppearance is an optional sparse object; normalize an absent
      // value to null so the record comparison never sees undefined.
      const now = (sw[STAMPED_RECORDS[i]!] ?? null) as Readonly<Record<string, unknown>> | null;
      if (was === now) continue;
      if (was === null || now === null || !sameDurableRecord(was, now)) changed = true;
      stamp.records[i] = now;
    }
    for (let i = 0; i < STAMPED_VALUES.length; i++) {
      const now = sw[STAMPED_VALUES[i]!];
      if (Object.is(stamp.values[i], now)) continue;
      changed = true;
      stamp.values[i] = now;
    }
    const appearance = sw.playerAppearance === undefined ? null : effectivePlayerAppearance(sw).sprite;
    if (stamp.appearance !== appearance) {
      changed = true;
      stamp.appearance = appearance;
    }
    if (stamp.ext !== ext) {
      const key = previewKey(ext);
      if (!Object.is(stamp.extKey, key)) changed = true;
      stamp.ext = ext;
      stamp.extKey = key;
    }
    return changed;
  };

  const enqueue = (mapId: string): void => {
    if (job?.map.id === mapId) return;
    if (!queue.includes(mapId)) queue.push(mapId);
  };

  const startJob = (map: Readonly<MapDef>): Job => {
    const { base, probes } = defaultSandboxProbes(map, options);
    return {
      map,
      generation,
      state: state!,
      compiled: !holdSandboxMap(sandbox, live, map),
      runs: [],
      probes,
      baseProbe: base,
    };
  };

  const finish = (current: Job): void => {
    const fallback = staticReader ? staticReader.read(current.map, current.state.sw) : undefined;
    const preview = assembleSandboxPreview(current.map, commonEvents, current.base!, current.runs, fallback);
    cache.set(current.map.id, { map: current.map, generation: current.generation, preview });
    stats.completed++;
  };

  const reader: SandboxPreviewReader = {
    stats,
    observe(next) {
      if (next === state) return;
      state = next;
      if (durableChanged(next.sw, next.ext)) {
        generation++;
        stats.invalidations++;
      }
    },
    read(map) {
      const hit = cache.get(map.id);
      if (!hit || hit.map !== map || hit.generation !== generation) {
        enqueue(map.id);
        stats.pending = queue.length + (job ? 1 : 0);
      }
      return hit?.map === map ? hit.preview : undefined;
    },
    pump() {
      let replaced = false;
      for (let units = 0; units < unitsPerPump; units++) {
        if (job && (job.generation !== generation || sandbox.maps.get(job.map.id) !== job.map)) {
          stats.restarted++;
          queue.unshift(job.map.id);
          job = undefined;
        }
        if (!job) {
          let map: Readonly<MapDef> | undefined;
          while (!map && queue.length > 0) {
            const id = queue.shift()!;
            const hit = cache.get(id);
            const resident = live.maps.get(id) ?? live.preparingMaps.get(id)?.map;
            if (!resident || (hit && hit.map === resident && hit.generation === generation)) continue;
            map = resident;
          }
          if (!map || !state) break;
          job = startJob(map);
        }
        const current = job;
        if (!current.compiled) {
          current.compiled = compileSandboxMap(sandbox, current.map.id);
          stats.compiles++;
          continue;
        }
        stats.probes++;
        if (!current.base) {
          current.base = runSandboxEntry(sandbox, current.state, current.map.id, current.baseProbe);
        } else {
          const next = current.probes[current.runs.length]!;
          current.runs.push({ reason: next.reason, run: runSandboxEntry(sandbox, current.state, current.map.id, next.probe) });
        }
        if (current.base.outcome !== "ok" || current.runs.length === current.probes.length) {
          finish(current);
          job = undefined;
          replaced = true;
        }
      }
      stats.pending = queue.length + (job ? 1 : 0);
      return replaced;
    },
    retain(mapIds) {
      const keep = new Set(mapIds);
      for (const id of [...cache.keys()]) if (!keep.has(id)) cache.delete(id);
      for (let i = queue.length - 1; i >= 0; i--) if (!keep.has(queue[i]!)) queue.splice(i, 1);
      if (job && !keep.has(job.map.id)) job = undefined;
      trimSandboxMaps(sandbox, keep);
      stats.pending = queue.length + (job ? 1 : 0);
    },
  };
  return reader;
}

export { createSandboxSession, holdSandboxMap, compileSandboxMap, trimSandboxMaps };
