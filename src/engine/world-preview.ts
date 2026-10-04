// Read-only NPC preview for a map the player has not entered yet (seamless
// worlds, plan 3.4). A neighbouring map never runs: its pages, routes and
// autorun/parallel programs belong to it only after a handoff. What the
// connected-world renderer may show across a seam is therefore a static
// snapshot of the map-entry state — the page each event would select on
// entry, at its authored cell and page facing — and only for events whose
// entry snapshot is provably what the first presented target frame shows.
//
// Everything here is pure: the input state is read, never written, and no
// interpreter, character table or extension handler is created or called.
// The same functions back the renderer and an importer's coverage report.

import { keyedRecord } from "./clone.ts";
import { eventIdLess, eventKey, effectivePlayerAppearance, type SwitchState } from "./interpreter.ts";
import type {
  Command,
  CommonEvent,
  WorldPreviewRejectReason,
  Condition,
  Dir,
  GameEvent,
  MapDef,
  Page,
  PageCondition,
} from "./types.ts";

export type { WorldPreviewRejectReason };

/** Every reject reason in report order. */
export const WORLD_PREVIEW_REJECT_REASONS: readonly WorldPreviewRejectReason[] = [
  "duplicate-id",
  "entry-opaque-command",
  "facing-condition",
  "runtime-condition",
  "extension-condition",
  "visit-condition",
  "entry-actor-command",
  "entry-state-write",
];

/** One previewed character: the entry page's sprite at the authored cell. */
export interface WorldPreviewActor {
  eventId: string;
  pageIndex: number;
  /** Map-local authored tile. */
  x: number;
  y: number;
  /** The page's spawn facing (`page.dir`, default down), exactly as
   * map-entry page sync creates the character. */
  dir: Dir;
  sprite: string;
}

export interface WorldPreviewRejection {
  eventId: string;
  reason: WorldPreviewRejectReason;
}

/** The read-only preview of one map for one durable state. */
export interface WorldMapPreview {
  mapId: string;
  /** Previewed characters in event-id order. */
  actors: readonly WorldPreviewActor[];
  /** Events that could paint but are not previewed, in event-id order. */
  rejected: readonly WorldPreviewRejection[];
  /** Events that paint nothing on entry (no selectable page with a sprite). */
  hidden: number;
  /** Every authored event on the map: actors + rejected + hidden. */
  events: number;
}

export interface WorldPreviewCoverage {
  maps: number;
  events: number;
  previewed: number;
  hidden: number;
  rejected: number;
  /** Count per reason; every reason is present (zero when unused). */
  reasons: Record<WorldPreviewRejectReason, number>;
}

export interface WorldPreviewOptions {
  /** The project's common events. `common` calls are followed; parallel
   * common events whose gate is open are counted as entry-time writers,
   * conservatively, although the session never starts them by itself. */
  commonEvents?: readonly CommonEvent[];
}

// --- static analysis ---------------------------------------------------------

type ContextReason = "facing-condition" | "runtime-condition" | "extension-condition" | "visit-condition";

/** One bit per reason, ranked by WORLD_PREVIEW_REJECT_REASONS: an event
 * collects every applicable reason and reports the lowest bit, so neither
 * clause order nor the order of equally undecidable pages changes it. */
function reasonBit(reason: WorldPreviewRejectReason): number {
  return 1 << WORLD_PREVIEW_REJECT_REASONS.indexOf(reason);
}

function firstReason(mask: number): WorldPreviewRejectReason {
  return WORLD_PREVIEW_REJECT_REASONS[31 - Math.clz32(mask & -mask)]!;
}

interface PageReads {
  switches: readonly string[];
  variables: readonly string[];
  items: readonly string[];
  self: boolean;
  gold: boolean;
  playerAppearance: boolean;
  /** Reason bits of every clause whose truth the preview cannot decide
   * (0 when the page is decidable). */
  context: number;
}

/** Writes of one program. `this` effects resolve against the issuing event
 * when the program runs; a global parallel common event has no event. */
interface Writes {
  switches: Set<string>;
  variables: Set<string>;
  items: Set<string>;
  allItems: boolean;
  gold: boolean;
  playerAppearance: boolean;
  selfThis: boolean;
  actors: Set<string>;
  actorThis: boolean;
  opaque: boolean;
}

interface EventAnalysis {
  ev: GameEvent;
  key: string;
  duplicate: boolean;
  reads: readonly PageReads[];
  /** Union of every page's built-in reads (a page switch can select any). */
  allReads: PageReads;
  /** Writes of each autorun/parallel page; null for other triggers. */
  writes: readonly (Writes | null)[];
  paints: readonly boolean[];
  anyPaints: boolean;
}

interface MapAnalysis {
  events: readonly EventAnalysis[];
}

const mapAnalyses = /* @__PURE__ */ new WeakMap<MapDef, Map<readonly CommonEvent[] | undefined, MapAnalysis>>();
// Keyed by the common-event list first: a `common` call inside the same
// commands array resolves differently against another project's list.
const commonWrites = /* @__PURE__ */ new WeakMap<readonly CommonEvent[], WeakMap<readonly Command[], Writes>>();
const NO_COMMON_EVENTS: readonly CommonEvent[] = [];

function emptyWrites(): Writes {
  return {
    switches: new Set(),
    variables: new Set(),
    items: new Set(),
    allItems: false,
    gold: false,
    playerAppearance: false,
    selfThis: false,
    actors: new Set(),
    actorThis: false,
    opaque: false,
  };
}

function mergeWrites(into: Writes, from: Writes): void {
  for (const id of from.switches) into.switches.add(id);
  for (const id of from.variables) into.variables.add(id);
  for (const id of from.items) into.items.add(id);
  for (const id of from.actors) into.actors.add(id);
  into.allItems ||= from.allItems;
  into.gold ||= from.gold;
  into.playerAppearance ||= from.playerAppearance;
  into.selfThis ||= from.selfThis;
  into.actorThis ||= from.actorThis;
  into.opaque ||= from.opaque;
}

function writeActor(out: Writes, target: "player" | "this" | { event: string }): void {
  if (target === "player") return;
  if (target === "this") out.actorThis = true;
  else out.actors.add(target.event);
}

function collectWrites(
  commands: readonly Command[],
  common: ReadonlyMap<string, CommonEvent>,
  out: Writes,
  visiting: Set<string>,
): void {
  for (const command of commands) {
    switch (command.op) {
      case "switch": out.switches.add(command.id); break;
      case "variable": out.variables.add(command.id); break;
      case "selfSwitch": out.selfThis = true; break;
      case "item": out.items.add(command.item); break;
      case "gold": out.gold = true; break;
      case "timer":
        if (command.action === "read") out.variables.add(command.variable);
        break;
      case "inputNumber":
      case "selectItem":
      case "locationInfo":
        out.variables.add(command.variable);
        break;
      case "appearance":
        if (command.target === "player") out.playerAppearance = true;
        else writeActor(out, command.target);
        break;
      case "moveRoute":
      case "moveControl":
      case "place":
        writeActor(out, command.target);
        break;
      case "erase": out.actorThis = true; break;
      case "if":
        collectWrites(command.then, common, out, visiting);
        if (command.else) collectWrites(command.else, common, out, visiting);
        break;
      case "choices":
        for (const option of command.options) collectWrites(option.commands, common, out, visiting);
        if (command.cancel) collectWrites(command.cancel.commands, common, out, visiting);
        break;
      case "loop": collectWrites(command.commands, common, out, visiting); break;
      case "common": {
        const called = common.get(command.id);
        if (!called) {
          out.opaque = true;
          break;
        }
        if (visiting.has(called.id)) break;
        visiting.add(called.id);
        collectWrites(called.commands, common, out, visiting);
        visiting.delete(called.id);
        break;
      }
      // Game-owned or host-owned effects: the kit cannot bound what they
      // write, so they make every event on the map unprovable.
      case "ext":
      case "extChoice":
      case "battle":
      case "scene":
      case "shop":
      case "transfer":
      case "openMenu":
      case "openSave":
      case "autosave":
      case "gameOver":
      case "returnTitle":
        out.opaque = true;
        break;
      // Presentation, audio, flow and per-visit visual state: none of these
      // changes page selection, a character's cell/facing, or its sprite.
      case "text":
      case "changeName":
      case "mapNameDisplay":
      case "menuAccess":
      case "saveAccess":
      case "layer":
      case "changeParallax":
      case "tileProperty":
      case "screenFade":
      case "screenTint":
      case "screenFlash":
      case "screenShake":
      case "camera":
      case "scrollMap":
      case "balloon":
      case "screenBackdrop":
      case "showPicture":
      case "movePicture":
      case "rotatePicture":
      case "tintPicture":
      case "erasePicture":
      case "wait":
      case "se":
      case "playBgm":
      case "fadeoutBgm":
      case "stopBgm":
      case "pauseBgm":
      case "resumeBgm":
      case "playBgs":
      case "fadeoutBgs":
      case "playMe":
      case "playSe":
      case "stopSe":
      case "saveBgm":
      case "replayBgm":
      case "exit":
      case "break":
      case "label":
      case "jumpLabel":
      case "mapAnim":
      case "stopAnim":
      case "lockInput":
      case "unlockInput":
        break;
      default: {
        // A new command must be classified above; until then it is opaque.
        const unknown: never = command;
        void unknown;
        out.opaque = true;
      }
    }
  }
}

function programWrites(commands: readonly Command[], common: ReadonlyMap<string, CommonEvent>): Writes {
  const out = emptyWrites();
  collectWrites(commands, common, out, new Set());
  return out;
}

function clauseContext(clause: Condition): ContextReason | null {
  switch (clause.kind) {
    case "facing": return "facing-condition";
    case "worldIdle":
    case "bgmPlaying":
    case "timer":
      return "runtime-condition";
    case "ext": return "extension-condition";
    case "tileProperty":
    case "region":
      return "visit-condition";
    case "appearance": return clause.target === "player" ? null : "visit-condition";
    case "switch":
    case "variable":
    case "selfSwitch":
    case "item":
    case "gold":
      return null;
  }
}

function conditionReads(condition: PageCondition | undefined): PageReads {
  const switches: string[] = [];
  const variables: string[] = [];
  const items: string[] = [];
  let self = false;
  let gold = false;
  let playerAppearance = false;
  let context = 0;
  if (condition) {
    if (condition.switch !== undefined) switches.push(condition.switch);
    if (condition.selfSwitch !== undefined) self = true;
    if (condition.variable !== undefined) variables.push(condition.variable.id);
    if (condition.item !== undefined) items.push(condition.item);
    for (const clause of condition.all ?? []) {
      const reason = clauseContext(clause);
      if (reason !== null) context |= reasonBit(reason);
      switch (clause.kind) {
        case "switch": switches.push(clause.id); break;
        case "variable": variables.push(clause.id); break;
        case "item": items.push(clause.id); break;
        case "selfSwitch": self = true; break;
        case "gold": gold = true; break;
        case "appearance": if (clause.target === "player") playerAppearance = true; break;
        default: break;
      }
    }
  }
  return { switches, variables, items, self, gold, playerAppearance, context };
}

function unionReads(reads: readonly PageReads[]): PageReads {
  const switches = new Set<string>();
  const variables = new Set<string>();
  const items = new Set<string>();
  let self = false;
  let gold = false;
  let playerAppearance = false;
  for (const read of reads) {
    for (const id of read.switches) switches.add(id);
    for (const id of read.variables) variables.add(id);
    for (const id of read.items) items.add(id);
    self ||= read.self;
    gold ||= read.gold;
    playerAppearance ||= read.playerAppearance;
  }
  return {
    switches: [...switches],
    variables: [...variables],
    items: [...items],
    self,
    gold,
    playerAppearance,
    context: 0,
  };
}

function isEntryTrigger(page: Page): boolean {
  return page.trigger === "autorun" || page.trigger === "parallel";
}

function analyzeMap(map: Readonly<MapDef>, commonEvents: readonly CommonEvent[] | undefined): MapAnalysis {
  let byCommon = mapAnalyses.get(map);
  const hit = byCommon?.get(commonEvents);
  if (hit) return hit;
  const common = new Map((commonEvents ?? []).map((event) => [event.id, event] as const));
  const counts = new Map<string, number>();
  for (const ev of map.events ?? []) counts.set(ev.id, (counts.get(ev.id) ?? 0) + 1);
  const events: EventAnalysis[] = [];
  for (const ev of map.events ?? []) {
    const reads = ev.pages.map((page) => conditionReads(page.condition));
    const paints = ev.pages.map((page) => page.sprite !== null && page.sprite !== undefined);
    events.push({
      ev,
      key: eventKey(map.id, ev.id),
      duplicate: counts.get(ev.id)! > 1,
      reads,
      allReads: unionReads(reads),
      writes: ev.pages.map((page) => isEntryTrigger(page) ? programWrites(page.commands, common) : null),
      paints,
      anyPaints: paints.includes(true),
    });
  }
  events.sort((a, b) => eventIdLess(a.ev.id, b.ev.id) ? -1 : a.ev.id === b.ev.id ? 0 : 1);
  const analysis: MapAnalysis = { events };
  if (!byCommon) {
    byCommon = new Map();
    mapAnalyses.set(map, byCommon);
  }
  byCommon.set(commonEvents, analysis);
  return analysis;
}

function commonProgramWrites(
  list: readonly CommonEvent[],
  event: CommonEvent,
  common: ReadonlyMap<string, CommonEvent>,
): Writes {
  let byCommands = commonWrites.get(list);
  if (!byCommands) {
    byCommands = new WeakMap();
    commonWrites.set(list, byCommands);
  }
  let writes = byCommands.get(event.commands);
  if (!writes) {
    writes = programWrites(event.commands, common);
    byCommands.set(event.commands, writes);
  }
  return writes;
}

// --- entry-state evaluation ----------------------------------------------------

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function isLocal(id: string): boolean {
  return id.startsWith("local.");
}

/** Built-in condition truth against the map-entry bank: entering a map
 * clears every `local.*` switch and variable before its pages are chosen. */
function entryClauseHolds(clause: Condition, sw: Readonly<SwitchState>, key: string): boolean {
  switch (clause.kind) {
    case "switch": {
      const value = isLocal(clause.id) ? false : own(sw.switches, clause.id) ?? false;
      return value === (clause.value ?? true);
    }
    case "variable": {
      const v = isLocal(clause.id) ? 0 : own(sw.variables, clause.id) ?? 0;
      if (typeof v !== "number") return false;
      switch (clause.op) {
        case ">=": return v >= clause.value;
        case "<=": return v <= clause.value;
        case "==": return v === clause.value;
        case "!=": return v !== clause.value;
      }
      return false;
    }
    case "selfSwitch":
      return (own(sw.self, key) === clause.key) === (clause.value ?? true);
    case "item":
      return (own(sw.items, clause.id) ?? 0) >= clause.count;
    case "gold":
      return sw.gold >= clause.amount;
    case "appearance":
      // Only the player target reaches here (other targets are context).
      return effectivePlayerAppearance(sw).sprite === clause.sprite;
    default:
      return false;
  }
}

/** Mirrors interpreter conditionHolds for a page without context clauses. */
function entryConditionHolds(
  condition: PageCondition | undefined,
  sw: Readonly<SwitchState>,
  key: string,
): boolean {
  if (!condition) return true;
  if (condition.switch !== undefined &&
      !(isLocal(condition.switch) ? false : own(sw.switches, condition.switch) ?? false)) return false;
  if (condition.selfSwitch !== undefined && own(sw.self, key) !== condition.selfSwitch) return false;
  if (condition.variable) {
    const { id, op, value } = condition.variable;
    const v = isLocal(id) ? 0 : own(sw.variables, id) ?? 0;
    if (typeof v !== "number") return false;
    if (op === ">=" && !(v >= value)) return false;
    if (op === "<=" && !(v <= value)) return false;
    if (op === "==" && !(v === value)) return false;
    if (op === "!=" && !(v !== value)) return false;
  }
  if (condition.item !== undefined && (own(sw.items, condition.item) ?? 0) < 1) return false;
  for (const clause of condition.all ?? []) {
    if (!entryClauseHolds(clause, sw, key)) return false;
  }
  return true;
}

interface Selection {
  /** The highest page that certainly holds, or -1. */
  index: number;
  /** Pages above `index` whose truth is undecidable, highest first. */
  uncertain: readonly number[];
  /** Union of the uncertain pages' context reason bits. */
  context: number;
}

function selectEntryPage(event: EventAnalysis, sw: Readonly<SwitchState>): Selection {
  const uncertain: number[] = [];
  let context = 0;
  const pages = event.ev.pages;
  for (let i = pages.length - 1; i >= 0; i--) {
    const reads = event.reads[i]!;
    if (reads.context !== 0) {
      uncertain.push(i);
      context |= reads.context;
      continue;
    }
    if (entryConditionHolds(pages[i]!.condition, sw, event.key)) return { index: i, uncertain, context };
  }
  return { index: -1, uncertain, context };
}

function readsIntersect(reads: PageReads, writes: Writes, selfWritten: boolean): boolean {
  if (selfWritten && reads.self) return true;
  if (writes.gold && reads.gold) return true;
  if (writes.playerAppearance && reads.playerAppearance) return true;
  for (const id of reads.switches) if (writes.switches.has(id)) return true;
  for (const id of reads.variables) if (writes.variables.has(id)) return true;
  for (const id of reads.items) if (writes.allItems || writes.items.has(id)) return true;
  return false;
}

/** The read-only map-entry preview of `map` under the durable bank `sw`.
 *
 * Rules (all conservative; anything unprovable is rejected, never guessed):
 * - Pages are chosen exactly as map entry does — highest holding page, with
 *   `local.*` ids cleared — at the authored cell with the page's facing.
 *   Per-visit state (erase, place, appearance overrides, runtime tile
 *   properties) is fresh on entry and therefore never consulted.
 * - A page whose condition reads a facing, runtime, extension or per-visit
 *   clause cannot be decided before entry; if it sits at or above the page
 *   that would otherwise win, the event is rejected.
 * - Autorun and parallel pages that may be active on entry run on the first
 *   target tick. Their writes, plus those of every parallel common event
 *   whose gate is open (counted conservatively: the session never starts
 *   them by itself), are closed over every page they could activate. An
 *   event is rejected when those writes reach its page condition or its
 *   character; an unboundable command, including a call to a missing
 *   common event, rejects the map.
 * - Each rejected event reports the first applicable reason in
 *   WORLD_PREVIEW_REJECT_REASONS order.
 * - Events that cannot paint anything on entry are `hidden`, not rejected. */
export function selectWorldMapPreview(
  map: Readonly<MapDef>,
  sw: Readonly<SwitchState>,
  options: WorldPreviewOptions = {},
): WorldMapPreview {
  const analysis = analyzeMap(map, options.commonEvents);
  const commonEvents = options.commonEvents ?? NO_COMMON_EVENTS;
  const common = new Map(commonEvents.map((event) => [event.id, event] as const));
  const selections = analysis.events.map((event) => selectEntryPage(event, sw));

  // Entry writers: every autorun/parallel page that may be the selected page.
  const writes = emptyWrites();
  const selfWritten = new Set<string>();
  const actorWritten = new Set<string>();
  const activeWriterEvents = new Set<number>();
  const addPageWrites = (eventIndex: number, pageIndex: number): void => {
    const page = analysis.events[eventIndex]!.writes[pageIndex];
    if (!page) return;
    mergeWrites(writes, page);
    const id = analysis.events[eventIndex]!.ev.id;
    if (page.selfThis) selfWritten.add(analysis.events[eventIndex]!.key);
    if (page.actorThis) actorWritten.add(id);
  };
  const addAllEntryPages = (eventIndex: number): void => {
    if (activeWriterEvents.has(eventIndex)) return;
    activeWriterEvents.add(eventIndex);
    const pages = analysis.events[eventIndex]!.writes;
    for (let i = 0; i < pages.length; i++) addPageWrites(eventIndex, i);
  };
  for (let e = 0; e < analysis.events.length; e++) {
    const selection = selections[e]!;
    for (const i of selection.uncertain) addPageWrites(e, i);
    if (selection.index >= 0) addPageWrites(e, selection.index);
  }
  const commonStarted = new Set<string>();
  let parallelSelfUnknown = false;
  const addCommonParallels = (): void => {
    for (const event of commonEvents) {
      if (event.trigger !== "parallel" || commonStarted.has(event.id)) continue;
      const gate = event.conditionSwitch;
      const on = gate === undefined || writes.switches.has(gate) ||
        (!isLocal(gate) && (own(sw.switches, gate) ?? false));
      if (!on) continue;
      commonStarted.add(event.id);
      const program = commonProgramWrites(commonEvents, event, common);
      mergeWrites(writes, program);
      // A global parallel has no issuing event: a `this` effect has no
      // provable target, so it reaches every event conservatively.
      if (program.selfThis || program.actorThis) parallelSelfUnknown = true;
    }
  };
  addCommonParallels();

  // Close the writes over pages they could switch on.
  const dirty = new Array<boolean>(analysis.events.length).fill(false);
  for (let changed = true; changed && !writes.opaque;) {
    changed = false;
    for (let e = 0; e < analysis.events.length; e++) {
      if (dirty[e]) continue;
      const event = analysis.events[e]!;
      if (!readsIntersect(event.allReads, writes, parallelSelfUnknown || selfWritten.has(event.key))) continue;
      dirty[e] = true;
      changed = true;
      addAllEntryPages(e);
    }
    const before = commonStarted.size;
    addCommonParallels();
    if (commonStarted.size !== before) changed = true;
  }

  const actors: WorldPreviewActor[] = [];
  const rejected: WorldPreviewRejection[] = [];
  let hidden = 0;
  for (let e = 0; e < analysis.events.length; e++) {
    const event = analysis.events[e]!;
    const selection = selections[e]!;
    // What could this event paint on entry? A dirty event may land on any
    // page; otherwise only the uncertain pages and the certain winner.
    const mayPaint = dirty[e] || writes.opaque
      ? event.anyPaints
      : selection.uncertain.some((i) => event.paints[i]) ||
        (selection.index >= 0 && event.paints[selection.index]!);
    if (!mayPaint) {
      hidden++;
      continue;
    }
    // Every applicable reason; the declaration-order first one is reported.
    let reasons = selection.context;
    if (event.duplicate) reasons |= reasonBit("duplicate-id");
    if (writes.opaque) reasons |= reasonBit("entry-opaque-command");
    if (parallelSelfUnknown || actorWritten.has(event.ev.id) || writes.actors.has(event.ev.id)) {
      reasons |= reasonBit("entry-actor-command");
    }
    if (dirty[e]) reasons |= reasonBit("entry-state-write");
    if (reasons !== 0) {
      rejected.push({ eventId: event.ev.id, reason: firstReason(reasons) });
      continue;
    }
    const page = event.ev.pages[selection.index]!;
    actors.push({
      eventId: event.ev.id,
      pageIndex: selection.index,
      x: event.ev.x,
      y: event.ev.y,
      dir: page.dir ?? "down",
      sprite: page.sprite!,
    });
  }
  return { mapId: map.id, actors, rejected, hidden, events: analysis.events.length };
}

interface PreviewDependencies {
  switches: readonly string[];
  variables: readonly string[];
  items: readonly string[];
  self: readonly string[];
  gold: boolean;
  playerAppearance: boolean;
}

const previewDependencies = /* @__PURE__ */ new WeakMap<MapAnalysis, PreviewDependencies>();

/** Every durable value selectWorldMapPreview can read for this map: page
 * conditions of every event plus global parallel gates. */
function dependenciesOf(analysis: MapAnalysis, commonEvents: readonly CommonEvent[]): PreviewDependencies {
  let deps = previewDependencies.get(analysis);
  if (deps) return deps;
  const all = unionReads(analysis.events.map((event) => event.allReads));
  const switches = new Set(all.switches);
  for (const event of commonEvents) {
    if (event.trigger === "parallel" && event.conditionSwitch !== undefined) switches.add(event.conditionSwitch);
  }
  deps = {
    switches: [...switches],
    variables: all.variables,
    items: all.items,
    self: analysis.events.filter((event) => event.allReads.self).map((event) => event.key),
    gold: all.gold,
    playerAppearance: all.playerAppearance,
  };
  previewDependencies.set(analysis, deps);
  return deps;
}

function fillSignature(out: unknown[], deps: PreviewDependencies, sw: Readonly<SwitchState>): void {
  out.length = 0;
  for (const id of deps.switches) out.push(isLocal(id) ? false : own(sw.switches, id) ?? false);
  for (const id of deps.variables) out.push(isLocal(id) ? 0 : own(sw.variables, id) ?? 0);
  for (const id of deps.items) out.push(own(sw.items, id) ?? 0);
  for (const key of deps.self) out.push(own(sw.self, key));
  if (deps.gold) out.push(sw.gold);
  if (deps.playerAppearance) out.push(effectivePlayerAppearance(sw).sprite);
}

/** A memoizing reader for presentation code that previews the same maps
 * frame after frame. It returns the identical WorldMapPreview object while
 * none of the values the map's preview reads has changed, so a renderer can
 * skip its repaint by identity. Comparison is by value, so it is exact for
 * both immutable and in-place reducer folds. */
export interface WorldPreviewReader {
  read(map: Readonly<MapDef>, sw: Readonly<SwitchState>): WorldMapPreview;
}

export function createWorldPreviewReader(options: WorldPreviewOptions = {}): WorldPreviewReader {
  const commonEvents = options.commonEvents ?? [];
  const memo = new WeakMap<Readonly<MapDef>, { signature: unknown[]; preview: WorldMapPreview }>();
  const scratch: unknown[] = [];
  return {
    read(map, sw) {
      const deps = dependenciesOf(analyzeMap(map, options.commonEvents), commonEvents);
      fillSignature(scratch, deps, sw);
      const hit = memo.get(map);
      if (hit && hit.signature.length === scratch.length &&
          hit.signature.every((value, index) => Object.is(value, scratch[index]))) {
        return hit.preview;
      }
      const preview = selectWorldMapPreview(map, sw, options);
      memo.set(map, { signature: scratch.slice(), preview });
      return preview;
    },
  };
}

/** Aggregate per-map previews for a coverage report. */
export function summarizeWorldPreviewCoverage(previews: readonly WorldMapPreview[]): WorldPreviewCoverage {
  const reasons = keyedRecord<number>() as Record<WorldPreviewRejectReason, number>;
  for (const reason of WORLD_PREVIEW_REJECT_REASONS) reasons[reason] = 0;
  let events = 0;
  let previewed = 0;
  let hidden = 0;
  let rejected = 0;
  for (const preview of previews) {
    events += preview.events;
    previewed += preview.actors.length;
    hidden += preview.hidden;
    rejected += preview.rejected.length;
    for (const entry of preview.rejected) reasons[entry.reason]++;
  }
  return { maps: previews.length, events, previewed, hidden, rejected, reasons };
}
