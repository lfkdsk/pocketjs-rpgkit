// tools/rpgmaker-import/events.ts — RPG Maker MV/MZ event pages, command
// lists and move routes to the kit's event model (src/engine/types.ts).
//
// An RM command list is flat: `indent` nests a command under the nearest
// preceding command of a lower indent, every block body ends with a code-0
// line one level deeper, and block commands close with markers at their own
// indent (411/412 branch, 413 loop, 402/403/404 choices, 601..604 battle).
// `parseTree` rebuilds the nesting; the emitters walk the tree and record
// one coverage disposition per head command (continuation lines and branch
// markers are part of their head).
//
// Lowerings that keep behaviour exact count as Native: comparisons against
// another variable go through a scratch variable, `>`/`<` become `>=`/`<=`
// with the constant moved by one, transfers by variable become a search
// tree over the imported map ids, and constant multiplication goes through
// a scratch variable. Scratch variables (ids.tempVariableId) are written and
// read within one run of instant commands, so no other fiber can observe them.

import { NAME_INPUT_SCENE_ID } from "../../src/engine/name-input.ts";
import type {
  Command,
  CommonEvent,
  Condition,
  Dir,
  JsonValue,
  MoveFrequency,
  MoveRoute,
  MoveSpeed,
  MoveStep,
  Page,
  PageCondition,
  PictureBlendMode,
  PictureCoordinate,
  PictureOrigin,
  PictureTone,
  RouteTarget,
  ScreenColor,
  ShopGood,
  TextBoxLayout,
  Trigger,
} from "../../src/engine/types.ts";
import { RM_COMMAND_BY_CODE, RM_CONDITION_TYPES, RM_ROUTE_BY_CODE } from "./catalog.ts";
import type { Coverage, Disposition } from "./coverage.ts";
import {
  commonId,
  eventId,
  itemId,
  partySwitchId,
  switchId,
  tempVariableId,
  variableId,
} from "./ids.ts";
import { rmParallaxSpeed } from "./load.ts";
import type {
  RmAudio,
  RmCommand,
  RmCommonEvent,
  RmEventPage,
  RmMoveCommand,
  RmMoveRoute,
  RmPageConditions,
  RmProject,
} from "./rm-types.ts";
import { convertMessage } from "./text.ts";

export interface EventContext {
  rm: RmProject;
  cov: Coverage;
  placeholders: "visible" | "silent";
  /** kit map ids of all imported maps, by RM map id */
  maps: ReadonlyMap<number, string>;
  /** who owns the list being converted; `eventIds` maps RM event id -> kit
   *  id on the current map (page owners only) */
  owner:
    | {
        kind: "page";
        mapId: string;
        eventId: string;
        page: number;
        trigger: Trigger;
        eventIds: ReadonlyMap<number, string>;
      }
    | { kind: "common"; id: string; trigger: "none" | "parallel" | "autorun" };
  /** register a character image and return the kit sprite key (null = no image) */
  sprite(image: { characterName: string; characterIndex: number; tileId: number }): string | null;
  /** register a picture file (img/pictures/<name>.png); returns the screen-layer variant id */
  picture(name: string): string;
  /** Register a map parallax. Empty names clear it; a leading ! selects
   * zero-parallax (1:1 camera) movement while retaining the source name. */
  parallax(name: string): { image: string; zero: boolean } | null;
  /** Resolve an Animations.json entry cooked by project.ts. A command can
   * be degraded even though it remains playable (for example, because a
   * source blend mode was flattened against a transparent canvas). */
  animation(n: number): { id: string; disposition: "Native" | "Degraded"; reason?: string } | null;
  /** Diagnostic retained when an animation could not be cooked. */
  animationFailure(n: number): string | undefined;
  /** register balloon icon n (img/system/Balloon.png row n-1); returns the
   *  AnimationDef id or null when the project has no Balloon.png */
  balloon(n: number): string | null;
  /** register an audio file; returns the logical audio id */
  audio(kind: "bgm" | "bgs" | "me" | "se", name: string): string;
  /** unique id for a shop command inside this owner */
  nextShopId(): string;
  /** unique mapAnim instance id for Show Animation inside this owner */
  nextAnimationId(): string;
}

// --- constants -------------------------------------------------------------

/** Kit text box limits (schema.json: text.lines maxItems 4, maxLength 52;
 *  choices.prompt maxLength 52, option text 1..64). */
const TEXT_WIDTH = 52;
const TEXT_ROWS = 4;
const CHOICE_WIDTH = 64;
const MAX_CHOICES = 8;
/** schema.json: wait.seconds is in (0, 30]; item.count in 1..99. */
const MAX_WAIT_SECONDS = 30;
const MAX_ITEM_COUNT = 99;
/** MV/MZ run at 60 frames per second; kit durations are virtual seconds. */
const FPS = 60;
/** Scene_Map.fadeSpeed / Game_Interpreter.fadeSpeed: 24 frames. Fadeout and
 *  Fadein Screen each last 24 frames; a transfer fades out 24 and in 24, and
 *  the kit's transfer `fade` is the whole out+in time. */
const FADE_FRAMES = 24;
const TRANSFER_FADE_SECONDS = (2 * FADE_FRAMES) / FPS;
/** Sprite_Balloon: 8 frames x speed 8 + waitTime 12. */
const BALLOON_FRAMES = 76;
/** The kit's playMe needs an authored length and the importer does not
 *  decode audio; most stock MEs (Item, Inn, Victory) run 2..6 s. */
export const ME_DEFAULT_SECONDS = 4;
/** RM's default movement speed (events and the player). Route waits are
 *  converted against the mover's speed; an unknown mover is assumed at it. */
const RM_DEFAULT_SPEED = 4;
/** Kit tiles are 16 px; MV/MZ shake amplitudes are 48 px-tile pixels. */
const SHAKE_PIXEL_SCALE = 16 / 48;
/** Bits needed for the largest RM gold amount (99,999,999 < 2^27) and the
 *  largest item count (99 < 2^7) in the binary lowerings below. */
const GOLD_BITS = 27;
const ITEM_BITS = 7;
/** The screenTint layer RM's Tint Screen drives, and the screenBackdrop
 *  layer pictures show on. */
export const TONE_LAYER = "tone";
export const PICTURE_LAYER = "picture";

const DIR_OF: Readonly<Record<number, Dir>> = { 2: "down", 4: "left", 6: "right", 8: "up" };
const ITEM_KIND = ["item", "weapon", "armor"] as const;
const PICTURE_BLEND: readonly PictureBlendMode[] = ["normal", "add", "multiply", "screen"];
const PICTURE_EASING = ["linear", "easeIn", "easeOut", "easeInOut"] as const;

// --- tree ------------------------------------------------------------------

/** One head command with its continuation lines and nested blocks. */
export interface RmNode {
  cmd: RmCommand;
  /** Flat index of `cmd` in the source command list: the source order MV's
   *  jumpTo scans when resolving a label. Carried onto `label` commands so
   *  the runtime's label table picks the first label in source order even
   *  when the importer reorders branches (e.g. a reversed condition swaps
   *  then/else). */
  ord?: number;
  /** Continuation lines (401, 405, 408, 505, 605, 655, 657). */
  lines: RmCommand[];
  /** 111 then-body, 112 loop body, or lines nested under any other
   *  command (MZ Skip). */
  body?: RmNode[];
  /** 111 else-body, present when the branch has an Else (411). */
  elseBody?: RmNode[];
  /** 102 choice branches (402/403) and 301 result branches (601/602/603). */
  branches?: { marker: RmCommand; body: RmNode[] }[];
}

const CONTINUATION: Readonly<Record<number, number>> = {
  101: 401,
  105: 405,
  108: 408,
  205: 505,
  302: 605,
  355: 655,
  357: 657,
};
const STRAY = new Set([401, 405, 408, 505, 605, 655, 657, 402, 403, 404, 411, 412, 413, 601, 602, 603, 604]);

/** Rebuild the block structure of a flat RM command list. Malformed input
 *  (orphan markers or continuation lines, over-indented lines) is skipped
 *  rather than rejected. */
export function parseTree(list: readonly RmCommand[]): RmNode[] {
  let i = 0;
  const n = list.length;
  const isAt = (code: number, indent: number): boolean =>
    i < n && list[i]!.code === code && list[i]!.indent === indent;

  const block = (indent: number): RmNode[] => {
    const out: RmNode[] = [];
    while (i < n) {
      const c = list[i]!;
      if (c.indent < indent) break;
      if (c.indent > indent || STRAY.has(c.code)) {
        i++;
        continue;
      }
      if (c.code === 0) {
        i++;
        break;
      }
      out.push(one());
    }
    return out;
  };

  const one = (): RmNode => {
    const ord = i;
    const head = list[i++]!;
    const d = head.indent;
    const node: RmNode = { cmd: head, ord, lines: [] };
    const cont = CONTINUATION[head.code];
    if (cont !== undefined) {
      while (isAt(cont, d)) node.lines.push(list[i++]!);
    }
    switch (head.code) {
      case 111:
        node.body = block(d + 1);
        if (isAt(411, d)) {
          i++;
          node.elseBody = block(d + 1);
        }
        if (isAt(412, d)) i++;
        break;
      case 112:
        node.body = block(d + 1);
        if (isAt(413, d)) i++;
        break;
      case 102:
      case 301: {
        const markers = head.code === 102 ? [402, 403] : [601, 602, 603];
        const end = head.code === 102 ? 404 : 604;
        node.branches = [];
        while (i < n && list[i]!.indent === d && markers.includes(list[i]!.code)) {
          const marker = list[i++]!;
          node.branches.push({ marker, body: block(d + 1) });
        }
        if (isAt(end, d)) i++;
        break;
      }
      default:
        if (i < n && list[i]!.indent > d) node.body = block(d + 1);
    }
    return node;
  };

  const out: RmNode[] = [];
  while (i < n) out.push(...block(0));
  return out;
}

// --- conversion state --------------------------------------------------------

type OwnerTrigger = Trigger | "none";

interface State {
  ctx: EventContext;
  trigger: OwnerTrigger;
  /** A common event run by Common Event (117): its exit returns to the
   *  caller in RM but ends the whole fiber in the kit. */
  calledCommon: boolean;
  /** A parallel/autorun common event: RM runs it with event id 0, so
   *  self-switch, erase and "this event" commands are no-ops there. */
  eventless: boolean;
  /** Movement speed of "this" event's page, when known. */
  pageSpeed: number | undefined;
  selfMulti?: boolean;
  /** Per-conversion counter for the synthetic labels that keep an
   *  unevaluable condition's Then reachable by jumpLabel. Must reset per
   *  conversion so re-running the importer is byte-stable. */
  deadBranchSeq: number;
  /** Authored label names (118) and jump targets (119) in this list. MV
   *  scopes both to the flat command list, so a synthetic control-flow name
   *  that matches one could be reached by an authored jump or shadow an
   *  authored label. Synthetic names are generated to avoid this set. */
  reservedLabels: Set<string>;
}

/** Facts a branch body may rely on: gold/item floors proven by an
 *  enclosing condition, and the innermost loop kind. */
interface Scope {
  loop: boolean;
  gold: number;
  items: ReadonlyMap<string, number>;
}

const ROOT_SCOPE: Scope = { loop: false, gold: 0, items: new Map() };

function makeState(ctx: EventContext, trigger: OwnerTrigger, pageSpeed?: number): State {
  return {
    ctx,
    trigger,
    calledCommon: ctx.owner.kind === "common" && trigger === "none",
    eventless: ctx.owner.kind === "common" && trigger !== "none",
    pageSpeed,
    deadBranchSeq: 0,
    reservedLabels: new Set(),
  };
}

/** Collect every name the authored list uses for a label (118) or a jump
 *  target (119). MV scopes both to the flat command list, so a synthetic
 *  name matching one could be reached by an authored jump or shadow an
 *  authored label; deadBranch keeps its synthetic names out of this set. */
function collectReservedLabels(list: readonly RmCommand[], st: State): void {
  for (const c of list) {
    if (c.code === 118 || c.code === 119) {
      const name = c.parameters?.[0];
      if (typeof name === "string") st.reservedLabels.add(name);
    }
  }
}

function rec(st: State, code: number, d: Disposition, reason?: string): void {
  st.ctx.cov.record("command", String(code), d, reason);
}

function needs(code: number): string {
  const info = RM_COMMAND_BY_CODE.get(code);
  return info?.needsKit ? `needs ${info.needsKit}` : "not supported";
}

const num = (v: unknown, fallback = 0): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};
const int = (v: unknown, fallback = 0): number => Math.trunc(num(v, fallback));
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const seconds = (frames: unknown): number => Math.max(0, num(frames)) / FPS;
const byte = (v: unknown): number => clamp(int(v), 0, 255);

/** MV Select Item itemType is the database itypeId (1 regular, 2 key,
 *  3 hidden A, 4 hidden B). Returns the kit type for one of the four
 *  standard values, or undefined for anything else; the caller has already
 *  classified anything else as a non-standard itypeId (whose MV list is
 *  empty) and degrades it. */
function selectItemType(v: number): "regular" | "key" | "hiddenA" | "hiddenB" | undefined {
  switch (v) {
    case 1: return "regular";
    case 2: return "key";
    case 3: return "hiddenA";
    case 4: return "hiddenB";
    default: return undefined;
  }
}

/** RM map id of the page owner's map, when the owner is a page. */
function ownerRmMapId(st: State): number | undefined {
  const o = st.ctx.owner;
  if (o.kind !== "page") return undefined;
  for (const [rm, kit] of st.ctx.maps) if (kit === o.mapId) return rm;
  return undefined;
}

// --- public API ------------------------------------------------------------

/** Convert one command list for `ctx.owner`. */
export function convertCommands(list: RmCommand[], ctx: EventContext): Command[] {
  return convertList(list, ctx, ctx.owner.trigger);
}

function convertList(list: readonly RmCommand[], ctx: EventContext, trigger: OwnerTrigger, pageSpeed?: number): Command[] {
  const st = makeState(ctx, trigger, pageSpeed);
  collectReservedLabels(list, st);
  return emitList(parseTree(list), st, ROOT_SCOPE);
}

const TRIGGERS: readonly { key: string; trigger: Trigger; d: Disposition; reason?: string }[] = [
  { key: "action", trigger: "action", d: "Native" },
  { key: "playerTouch", trigger: "playerTouch", d: "Native" },
  { key: "eventTouch", trigger: "eventTouch", d: "Native" },
  { key: "autorun", trigger: "autorun", d: "Native" },
  { key: "parallel", trigger: "parallel", d: "Native" },
];

/** One event page. The trigger comes from the page itself; `ctx.owner` only
 *  supplies the map/event identity. */
export function convertPage(page: RmEventPage, index: number, ctx: EventContext): Page {
  const t = TRIGGERS[page.trigger] ?? TRIGGERS[0]!;
  // MV starts a same-priority Player Touch page when the player's step is
  // refused by the event body. The kit's playerTouch is entry-only, so use
  // eventTouch for that shape. It also reacts when the event walks into the
  // player, which MV reserves for Event Touch, hence the honest degradation.
  const blockingPlayerTouch = page.trigger === 1 && page.priorityType === 1;
  const trigger: Trigger = blockingPlayerTouch ? "eventTouch" : t.trigger;
  ctx.cov.record(
    "trigger",
    t.key,
    blockingPlayerTouch ? "Degraded" : t.d,
    blockingPlayerTouch
      ? "blocking Player Touch mapped to eventTouch; event movement into the player also fires"
      : t.reason,
  );
  const pctx: EventContext =
    ctx.owner.kind === "page" ? { ...ctx, owner: { ...ctx.owner, page: index, trigger } } : ctx;

  const out: Page = { trigger, commands: [] };
  const condition = convertPageConditions(page.conditions, pctx);
  if (condition) out.condition = condition;
  const img = page.image;
  out.sprite = img
    ? ctx.sprite({ characterName: img.characterName ?? "", characterIndex: img.characterIndex ?? 0, tileId: img.tileId ?? 0 })
    : null;
  const dir = img ? DIR_OF[img.direction] : undefined;
  if (dir && dir !== "down") out.dir = dir;
  // Only "same as characters" collides in RM; below/above are walkable
  // (drawing above characters is not modelled).
  out.blocks = page.priorityType === 1;
  const speed = clamp(int(page.moveSpeed, 3), 1, 6) as MoveSpeed;
  out.moveSpeed = speed;
  out.moveFrequency = clamp(int(page.moveFrequency, 3), 1, 5) as MoveFrequency;
  if (page.directionFix) out.directionFix = true;
  if (page.through) out.through = true;
  if (page.moveType === 1) out.moveType = "random";
  else if (page.moveType === 2) out.moveType = "approach";
  else if (page.moveType === 3 && page.moveRoute) {
    const route = routeOf(page.moveRoute, pctx, speed);
    if (route.steps.length > 0) out.moveRoute = { steps: route.steps, repeat: route.repeat, skippable: route.skippable };
  }
  out.commands = convertList(page.list ?? [], pctx, trigger, speed);
  return out;
}

/** Page activation conditions. Switches and the actor-in-party clause go to
 *  `all`; variable (>=), self switch and item use the flat fields. */
export function convertPageConditions(c: RmPageConditions, ctx: EventContext): PageCondition | undefined {
  if (!c) return undefined;
  const out: PageCondition = {};
  const all: Condition[] = [];
  const recc = (key: string): void => ctx.cov.record("pageCondition", key, "Native");
  if (c.switch1Valid) {
    all.push({ kind: "switch", id: switchId(c.switch1Id) });
    recc("switch");
  }
  if (c.switch2Valid) {
    all.push({ kind: "switch", id: switchId(c.switch2Id) });
    recc("switch");
  }
  if (c.variableValid) {
    out.variable = { id: variableId(c.variableId), op: ">=", value: int(c.variableValue) };
    recc("variable");
  }
  if (c.selfSwitchValid && isSelfKey(c.selfSwitchCh)) {
    out.selfSwitch = c.selfSwitchCh;
    recc("selfSwitch");
  }
  if (c.itemValid) {
    // MV hasItem: items only, equipped copies never count.
    out.item = itemId("item", c.itemId);
    recc("item");
  }
  if (c.actorValid) {
    all.push({ kind: "switch", id: partySwitchId(c.actorId) });
    recc("actor");
  }
  if (all.length > 0) out.all = all;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A Set Movement Route route or a page's custom route. The mover's speed
 *  is taken as RM's default (4) for converting route waits. */
export function convertMoveRoute(route: RmMoveRoute, ctx: EventContext): MoveRoute {
  const r = routeOf(route, ctx, RM_DEFAULT_SPEED);
  return { steps: r.steps, repeat: r.repeat, skippable: r.skippable };
}

/** A common event. RM trigger 1 (autorun) has no kit counterpart and runs
 *  as a parallel common event under the same switch: it no longer blocks
 *  the player while it runs. */
export function convertCommonEvent(ce: RmCommonEvent, ctx: EventContext): CommonEvent {
  const trigger = ce.trigger === 2 ? "parallel" : ce.trigger === 1 ? "autorun" : "none";
  if (trigger === "parallel") ctx.cov.record("trigger", "common parallel", "Native");
  if (trigger === "autorun") {
    ctx.cov.record("trigger", "common autorun", "Degraded", "runs as a parallel common event; does not block the player");
  }
  const id = ctx.owner.kind === "common" ? ctx.owner.id : commonId(ce.id);
  const cctx: EventContext = { ...ctx, owner: { kind: "common", id, trigger } };
  const out: CommonEvent = { id, trigger: trigger === "none" ? "none" : "parallel", commands: [] };
  if (ce.name) out.name = ce.name;
  if (trigger !== "none" && ce.switchId > 0) out.conditionSwitch = switchId(ce.switchId);
  out.commands = convertList(ce.list ?? [], cctx, trigger);
  return out;
}

// --- list / node emitters ---------------------------------------------------

function emitList(nodes: readonly RmNode[], st: State, scope: Scope): Command[] {
  const out: Command[] = [];
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k]!;
    const next = nodes[k + 1];
    if (nd.cmd.code === 101 && next?.cmd.code === 102) {
      out.push(...emitTextThenChoices(nd, next, st, scope));
      k++;
      continue;
    }
    out.push(...emitNode(nd, st, scope));
  }
  return out;
}

function emitNode(nd: RmNode, st: State, scope: Scope): Command[] {
  const { ctx } = st;
  const c = nd.cmd;
  const p = Array.isArray(c.parameters) ? c.parameters : [];
  const code = c.code;
  switch (code) {
    case 101: {
      const m = message(nd, st);
      rec(st, 101, m.reasons.length ? "Degraded" : "Native", m.reasons[0]);
      return textCommands(m.lines, m.layout);
    }
    case 102:
      return emitChoices(nd, st, scope, "");
    case 103:
      rec(st, 103, "Native");
      return [{ op: "inputNumber", variable: variableId(int(p[0])), digits: clamp(int(p[1], 1), 1, 8) }];
    case 104: {
      // MV's corescript is `setItemChoice(params[0], params[1] || 2)`: a
      // missing or zero itypeId is key items (2). Only the strict integers
      // 1-4 are standard itypeIds; any other value (0.5, 1.5, true, "2",
      // 5, ...) is a non-standard itypeId whose MV item list is empty,
      // which the kit cannot represent, so it is recorded Degraded —
      // naming the ORIGINAL value, never truncated or coerced into a
      // standard type — and dropped rather than faking a picker.
      const raw = p[1];
      if (raw === undefined || raw === null || raw === 0) {
        rec(st, 104, "Native");
        return [{ op: "selectItem", variable: variableId(int(p[0])), itemType: "key" }];
      }
      if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 4) {
        rec(st, 104, "Native");
        return [{ op: "selectItem", variable: variableId(int(p[0])), itemType: selectItemType(raw)! }];
      }
      rec(st, 104, "Degraded", `non-standard itypeId ${JSON.stringify(raw)}; MV's item list for it is empty, the kit supports only itypeIds 1-4`);
      return [];
    }
    case 105: {
      const lines = wrap(convertMessage(nd.lines.map((l) => String(l.parameters?.[0] ?? "")), ctx));
      rec(st, 105, "Degraded", "scrolling text shown as message pages");
      return lines.length > 0 ? textCommands(lines) : [];
    }
    case 108:
      rec(st, 108, "Native");
      return [];
    case 109:
      // MZ Skip: the commands nested under it never run.
      rec(st, 109, "Native");
      return [];
    case 111:
      return emitBranch(nd, st, scope);
    case 112: {
      rec(st, 112, "Native");
      return [{ op: "loop", commands: emitList(nd.body ?? [], st, { ...scope, loop: true }) }];
    }
    case 113:
      if (scope.loop) rec(st, 113, "Native");
      else rec(st, 113, "Degraded", "outside a parsed loop; malformed flat lists can differ at a stray Repeat Above");
      return [{ op: "break" }];
    case 115:
      return exitCommand(st, 115);
    case 117: {
      const n = int(p[0]);
      if (!ctx.rm.commonEvents[n]) {
        rec(st, 117, "Dropped", "common event does not exist");
        return [];
      }
      rec(st, 117, "Native");
      return [{ op: "common", id: commonId(n) }];
    }
    case 118:
      rec(st, 118, "Native");
      return [{ op: "label", name: String(p[0] ?? ""), ...(nd.ord !== undefined ? { ord: nd.ord } : {}) }];
    case 119:
      rec(st, 119, "Native");
      return [{ op: "jumpLabel", name: String(p[0] ?? "") }];
    case 121: {
      const out: Command[] = [];
      for (let id = int(p[0]); id <= int(p[1]); id++) out.push({ op: "switch", id: switchId(id), value: int(p[2]) === 0 });
      rec(st, 121, "Native");
      return out;
    }
    case 122:
      return emitVariables(p, st);
    case 123: {
      // RM runs parallel/autorun common events with event id 0, where Control
      // Self Switch does nothing.
      if (st.eventless) {
        rec(st, 123, "Native");
        return [];
      }
      const key = p[0];
      if (!isSelfKey(key)) {
        rec(st, 123, "Dropped", "unknown self switch");
        return [];
      }
      if (eventUsesSeveralSelfSwitches(st)) {
        rec(st, 123, "Degraded", "event uses several self switches; the kit keeps one per event");
      } else {
        rec(st, 123, "Native");
      }
      return [{ op: "selfSwitch", key, value: int(p[1]) === 0 }];
    }
    case 124:
      rec(st, 124, "Native");
      return int(p[0]) === 0
        ? [{ op: "timer", action: "start", seconds: Math.max(0, int(p[1])) }]
        : [{ op: "timer", action: "stop" }];
    case 125:
      return emitGold(p, st, scope);
    case 126:
    case 127:
    case 128:
      return emitItems(code, p, st, scope);
    case 129:
      // The party is one switch per actor (ids.partySwitchId), read by the
      // actor-in-party conditions; no party UI is modelled.
      rec(st, 129, "Native");
      return [{ op: "switch", id: partySwitchId(int(p[0])), value: int(p[1]) === 0 }];
    case 201:
      return emitTransfer(p, st);
    case 204:
      return emitScrollMap(p, st);
    case 203:
      return emitPlace(p, st);
    case 205:
      return emitMoveRoute(p, st);
    case 211:
      // Change Transparency: parameter 0 is ON (transparent).
      rec(st, 211, "Native");
      return [{ op: "appearance", target: "player", visible: int(p[0]) !== 0 }];
    case 212:
      return emitAnimation(p, st);
    case 213:
      return emitBalloon(p, st);
    case 214:
      rec(st, 214, "Native");
      return st.eventless ? [] : [{ op: "erase" }];
    case 221:
    case 222:
      // Fadeout/Fadein Screen wait for their own fade.
      rec(st, code, "Native");
      return [{ op: "screenFade", direction: code === 221 ? "out" : "in", duration: seconds(FADE_FRAMES), wait: true }];
    case 223:
      return emitTint(p, st);
    case 224: {
      const col = Array.isArray(p[0]) ? (p[0] as unknown[]) : [];
      rec(st, 224, "Native");
      return [{
        op: "screenFlash",
        color: { r: byte(col[0]), g: byte(col[1]), b: byte(col[2]), a: 255 },
        intensity: byte(col[3]),
        duration: seconds(p[1]),
        wait: !!p[2],
      }];
    }
    case 225:
      // Game_Screen.updateShake swings +-power*2 px at power*speed/10 px per
      // frame: a triangle wave of 80/speed frames per cycle. Amplitude is
      // rescaled from 48 px to 16 px tiles.
      rec(st, 225, "Native");
      return [{
        op: "screenShake",
        strength: Math.max(0, num(p[0])) * 2 * SHAKE_PIXEL_SCALE,
        speed: Math.max(0, num(p[1])) * (FPS / 80),
        duration: seconds(p[2]),
        wait: !!p[3],
      }];
    case 230:
      rec(st, 230, "Native");
      return waitCommands(seconds(p[0]));
    case 231:
      return emitShowPicture(p, st);
    case 232:
      return emitMovePicture(p, st);
    case 233:
      rec(st, 233, "Native");
      return [{ op: "rotatePicture", id: int(p[0]), speed: num(p[1]) / 2 }];
    case 234:
      return emitTintPicture(p, st);
    case 235:
      rec(st, 235, "Native");
      return [{ op: "erasePicture", id: int(p[0]) }];
    case 241:
    case 245:
    case 249:
    case 250:
      return emitAudio(code, p[0] as RmAudio | undefined, st);
    case 242:
      rec(st, 242, "Native");
      return [{ op: "fadeoutBgm", duration: Math.max(0, num(p[0])) }];
    case 243:
      rec(st, 243, "Native");
      return [{ op: "saveBgm" }];
    case 244:
      rec(st, 244, "Native");
      return [{ op: "replayBgm" }];
    case 246:
      rec(st, 246, "Native");
      return [{ op: "fadeoutBgs", duration: Math.max(0, num(p[0])) }];
    case 251:
      rec(st, 251, "Native");
      return [{ op: "stopSe" }];
    case 134:
      rec(st, 134, "Native");
      // MV: parameter 0 disables, any other value enables.
      return [{ op: "saveAccess", enabled: int(p[0]) !== 0 }];
    case 135:
      rec(st, 135, "Native");
      // MV: parameter 0 disables, any other value enables.
      return [{ op: "menuAccess", enabled: int(p[0]) !== 0 }];
    case 285: {
      rec(st, 285, "Native");
      // MV layout: [variableId, infoType, locationType, x, y]. infoType 0 is
      // terrain tag, 1 the live event id, 2-5 tile layers 1-4, anything else
      // region id. locationType 0 names direct coordinates, otherwise the two
      // parameters are variable ids.
      const infoType = int(p[1]);
      const kind = infoType === 0 ? "terrain" : infoType === 1 ? "event" : infoType >= 2 && infoType <= 5 ? "tile" : "region";
      const direct = int(p[2]) === 0;
      const out: Command = {
        op: "locationInfo",
        variable: variableId(int(p[0])),
        x: direct ? int(p[3]) : { variable: variableId(int(p[3])) },
        y: direct ? int(p[4]) : { variable: variableId(int(p[4])) },
        kind,
      };
      if (kind === "tile") out.layer = (int(p[1]) - 2) as 0 | 1 | 2 | 3;
      return [out];
    }
    case 281:
      rec(st, 281, "Native");
      return [{ op: "mapNameDisplay", visible: int(p[0]) === 0 }];
    case 284: {
      const art = ctx.parallax(String(p[0] ?? ""));
      rec(st, 284, "Native");
      return [{
        op: "changeParallax",
        image: art?.image ?? null,
        loopX: !!p[1],
        loopY: !!p[2],
        sx: rmParallaxSpeed(ctx.rm, clamp(num(p[3]), -32, 32)),
        sy: rmParallaxSpeed(ctx.rm, clamp(num(p[4]), -32, 32)),
        ...(art?.zero ? { zero: true } : {}),
      }];
    }
    case 301:
      return emitBattle(nd, p, st, scope);
    case 302:
      return emitShop(nd, p, st);
    case 303:
      return emitNameInput(p, st);
    case 320: {
      const actor = int(p[0]);
      if (actor !== 1) {
        rec(st, 320, "Degraded", "only actor 1 maps to the kit player name; other actor names are not modelled");
        return [];
      }
      const name = String(p[1] ?? "");
      if (name.length < 1) {
        rec(st, 320, "Degraded", "the kit player name cannot be empty; change ignored");
        return [];
      }
      const clipped = name.slice(0, 24);
      rec(st, 320, clipped === name ? "Native" : "Degraded", clipped === name ? undefined : "player name truncated to 24 characters");
      return [{ op: "changeName", name: clipped }];
    }
    case 351:
      rec(st, 351, "Native");
      return [{ op: "openMenu" }];
    case 352:
      rec(st, 352, "Native");
      return [{ op: "openSave" }];
    case 353:
      rec(st, 353, "Native");
      return [{ op: "gameOver" }, { op: "exit" }];
    case 354:
      rec(st, 354, "Native");
      return [{ op: "returnTitle" }, { op: "exit" }];
    case 355:
    case 356:
    case 357:
      return emitPlaceholder(nd, p, st);
    default: {
      const info = RM_COMMAND_BY_CODE.get(code);
      rec(st, code, "Dropped", info ? needs(code) : "unknown command code");
      // Anything nested under an unknown command is unreachable here.
      return [];
    }
  }
}

function exitCommand(st: State, code: number): Command[] {
  if (st.calledCommon) {
    rec(st, code, "Degraded", "in a called common event the kit's exit also ends the caller");
  } else {
    rec(st, code, "Native");
  }
  return [{ op: "exit" }];
}

// --- text and choices --------------------------------------------------------

/** Show Text background (params[2]: 0 window, 1 dim, 2 transparent) and
 *  position type (params[3]: 0 top, 1 middle, 2 bottom) as the text box
 *  layout. The defaults (window, bottom) are omitted, so a default message
 *  emits the plain text command. Any other value is shown as the default
 *  and noted. */
function messageLayout(p: readonly unknown[], reasons: string[]): TextBoxLayout {
  const layout: TextBoxLayout = {};
  const background = p[2];
  if (background === 1) layout.background = "dim";
  else if (background === 2) layout.background = "transparent";
  else if (background !== 0 && background != null) {
    reasons.push(`non-standard message background ${JSON.stringify(background)} shown as a window`);
  }
  const position = p[3];
  if (position === 0) layout.position = "top";
  else if (position === 1) layout.position = "center";
  else if (position !== 2 && position != null) {
    reasons.push(`non-standard message position ${JSON.stringify(position)} shown at the bottom`);
  }
  return layout;
}

function message(nd: RmNode, st: State): { lines: string[]; reasons: string[]; layout: TextBoxLayout } {
  const p = nd.cmd.parameters ?? [];
  const reasons: string[] = [];
  let lines = convertMessage(nd.lines.map((l) => String(l.parameters?.[0] ?? "")), st.ctx);
  // MZ speaker name: shown as a "Name: " prefix on the first line (the kit's
  // DialogBox only turns an upper-case NAME: prefix into a name tab when the
  // game supplies a portrait for it).
  const speaker = p[4];
  if (typeof speaker === "string" && speaker !== "") {
    const s = convertMessage([speaker], st.ctx)[0]!;
    lines = lines.length > 0 ? [`${s}: ${lines[0]}`, ...lines.slice(1)] : [`${s}:`];
  }
  if (typeof p[0] === "string" && p[0] !== "") reasons.push("face graphic not shown");
  const wrapped = wrap(lines);
  if (wrapped.length !== lines.length) reasons.push("long lines re-wrapped to the 52-column box");
  const layout = messageLayout(p, reasons);
  return { lines: wrapped.length > 0 ? wrapped : [""], reasons, layout };
}

/** One text command per TEXT_ROWS lines; every page carries the layout. */
function textCommands(lines: readonly string[], layout: TextBoxLayout = {}): Command[] {
  const out: Command[] = [];
  for (let k = 0; k < lines.length; k += TEXT_ROWS) out.push({ op: "text", lines: lines.slice(k, k + TEXT_ROWS), ...layout });
  return out;
}

/** Word-wrap to the kit's 52-column text box. */
export function wrap(lines: readonly string[], width = TEXT_WIDTH): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let rest = line;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      cut = tokenSafeCut(rest, cut);
      out.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  return out;
}

/** Never split a runtime text token while wrapping or truncating imported
 *  text. A token at column zero is shorter than either importer limit, but
 *  allowing its end also makes this helper total for hand-written ids. */
function tokenSafeCut(text: string, cut: number): number {
  for (const match of text.matchAll(/\{name\}|\{v:[^{}]*\}/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < cut && cut < end) return start > 0 ? start : end;
  }
  return cut;
}

function tokenSafeSlice(text: string, width: number): string {
  return text.slice(0, tokenSafeCut(text, Math.min(width, text.length)));
}

/** Show Text right before Show Choices: RM keeps the message on screen
 *  under the choice list. The kit hides the message box during choices and
 *  shows a one-line prompt, so a one-line message becomes the prompt; a
 *  longer one shows its earlier lines first and keeps the last as the
 *  prompt. The message's position/background go on those earlier text
 *  pages (and on the message a single-option list becomes); the choices
 *  command has no layout, so its prompt is drawn in the default choice box. */
function emitTextThenChoices(textNode: RmNode, choiceNode: RmNode, st: State, scope: Scope): Command[] {
  const m = message(textNode, st);
  const reasons = [...m.reasons];
  const out: Command[] = [];
  if (m.lines.length > 1) {
    reasons.push("only the last message line stays on screen with the choices");
    out.push(...textCommands(m.lines.slice(0, -1), m.layout));
  }
  rec(st, 101, reasons.length ? "Degraded" : "Native", reasons[0]);
  out.push(...emitChoices(choiceNode, st, scope, m.lines[m.lines.length - 1]!, m.layout));
  return out;
}

function choiceLabel(text: unknown, st: State): { text: string; truncated: boolean } {
  const converted = convertMessage([String(text ?? "")], st.ctx)[0]!;
  const s = tokenSafeSlice(converted, CHOICE_WIDTH);
  return { text: s.length > 0 ? s : "-", truncated: converted.length > CHOICE_WIDTH };
}

/** Show Choices. cancelType -2 runs the When Cancel branch, -1 disallows
 *  cancel, n >= 0 runs option n's branch (MV setupChoices treats n beyond
 *  the list as -2). */
function emitChoices(nd: RmNode, st: State, scope: Scope, prompt: string, layout: TextBoxLayout = {}): Command[] {
  const p = nd.cmd.parameters ?? [];
  const convertedLabels = (Array.isArray(p[0]) ? (p[0] as unknown[]) : []).map((t) => choiceLabel(t, st));
  const labels = convertedLabels.map((label) => label.text);
  let cancelType = int(p[1], -1);
  if (cancelType >= labels.length) cancelType = -2;
  const bodies: Command[][] = labels.map(() => []);
  let cancelBody: Command[] = [];
  for (const br of nd.branches ?? []) {
    const cmds = emitList(br.body, st, scope);
    if (br.marker.code === 403) cancelBody = cmds;
    else {
      const idx = int(br.marker.parameters?.[0], -1);
      if (idx >= 0 && idx < bodies.length) bodies[idx] = cmds;
    }
  }
  const reasons: string[] = [];
  if (convertedLabels.some((label) => label.truncated)) reasons.push("choice text longer than 64 characters truncated");
  if (int(p[2], 0) > 0) reasons.push("default cursor row not modelled");
  if (labels.length === 0) {
    rec(st, 102, "Dropped", "no options");
    return [];
  }
  const cancel =
    cancelType === -2 ? { commands: cancelBody }
    : cancelType >= 0 ? { commands: structuredClone(bodies[cancelType]!) }
    : undefined;
  if (labels.length === 1) {
    if (cancelType !== -2) {
      // One option the player must take (cancel absent or the same option):
      // a message with the option's label, then its branch.
      rec(st, 102, "Degraded", "single-option list shown as a message");
      return [...textCommands(wrap(prompt ? [prompt, labels[0]!] : [labels[0]!]), layout), ...bodies[0]!];
    }
    reasons.unshift("single-option list padded with a Cancel option");
    labels.push("Cancel");
    bodies.push(structuredClone(cancelBody));
  }
  if (labels.length > MAX_CHOICES) {
    reasons.unshift("more than 8 options truncated");
    labels.length = MAX_CHOICES;
    bodies.length = MAX_CHOICES;
  }
  rec(st, 102, reasons.length ? "Degraded" : "Native", reasons[0]);
  const cmd: Command = {
    op: "choices",
    prompt: tokenSafeSlice(prompt, TEXT_WIDTH),
    options: labels.map((text, k) => ({ text, commands: bodies[k]! })),
  };
  if (cancel) cmd.cancel = cancel;
  return [cmd];
}

// --- conditional branch ---------------------------------------------------------

interface CondResult {
  pre: Command[];
  /** null: the condition cannot be evaluated and is treated as false. */
  cond: Condition | null;
  /** The kit condition is the RM condition's negation: swap the bodies. */
  swap: boolean;
  d: Disposition;
  reason?: string;
  placeholder?: Command[];
}

const VAR_OPS = ["==", ">=", "<=", ">", "<", "!="] as const;

/** Compare variable `id` against integer `c` with an RM operator, lowering
 *  > and < to >= / <= on the neighbouring integer. */
function compare(id: string, op: number, c: number): Condition | null {
  const o = VAR_OPS[op];
  switch (o) {
    case "==":
    case ">=":
    case "<=":
    case "!=":
      return { kind: "variable", id, op: o, value: c };
    case ">":
      return { kind: "variable", id, op: ">=", value: c + 1 };
    case "<":
      return { kind: "variable", id, op: "<=", value: c - 1 };
    default:
      return null;
  }
}

function convertCondition(p: readonly unknown[], st: State): CondResult {
  const type = int(p[0], -1);
  const ok = (cond: Condition, pre: Command[] = []): CondResult => ({ pre, cond, swap: false, d: "Native" });
  const unknown = (d: Disposition, reason: string): CondResult => ({ pre: [], cond: null, swap: false, d, reason: `${reason}; treated as false` });
  switch (type) {
    case 0:
      return ok(int(p[2]) === 1 ? { kind: "switch", id: switchId(int(p[1])), value: false } : { kind: "switch", id: switchId(int(p[1])) });
    case 1: {
      const a = variableId(int(p[1]));
      if (int(p[2]) === 0) {
        const cond = compare(a, int(p[4]), int(p[3]));
        return cond ? ok(cond) : unknown("Dropped", "unknown comparison");
      }
      // Variable vs variable: tmp = a - b, then compare tmp against 0.
      const tmp = tempVariableId(1);
      const cond = compare(tmp, int(p[4]), 0);
      if (!cond) return unknown("Dropped", "unknown comparison");
      return ok(cond, [
        { op: "variable", id: tmp, set: { op: "copy", from: a } },
        { op: "variable", id: tmp, set: { op: "sub", from: variableId(int(p[3])) } },
      ]);
    }
    case 2: {
      // RM evaluates a self switch only with an event (id > 0).
      if (st.eventless) return { pre: [], cond: null, swap: false, d: "Native" };
      const key = p[1];
      if (!isSelfKey(key)) return unknown("Dropped", "unknown self switch");
      return ok(int(p[2]) === 1 ? { kind: "selfSwitch", key, value: false } : { kind: "selfSwitch", key });
    }
    case 3:
      return ok({
        kind: "timer",
        op: int(p[2]) === 0 ? ">=" : "<=",
        seconds: Math.max(0, int(p[1])),
      });
    case 4:
      if (int(p[2]) === 0) return ok({ kind: "switch", id: partySwitchId(int(p[1])) });
      return unknown("Degraded", "actor name/class/skill/equipment/state not modelled");
    case 5:
      return unknown("Degraded", "enemy conditions are battle-only");
    case 6: {
      const dir = DIR_OF[int(p[2])];
      if (int(p[1]) === -1 && dir) return ok({ kind: "facing", dir });
      return unknown("Degraded", "event facing is not readable");
    }
    case 7: {
      // 0 >=, 1 <=, 2 <: the kit only has gold >= n, so <= / < negate it.
      const amount = Math.max(0, int(p[1]));
      const op = int(p[2]);
      if (op === 0) return ok({ kind: "gold", amount });
      if (op === 1) return { pre: [], cond: { kind: "gold", amount: amount + 1 }, swap: true, d: "Native" };
      if (op === 2) return { pre: [], cond: { kind: "gold", amount }, swap: true, d: "Native" };
      return unknown("Dropped", "unknown comparison");
    }
    case 8:
      return ok({ kind: "item", id: itemId("item", int(p[1])), count: 1 });
    case 9:
    case 10: {
      const cond: Condition = { kind: "item", id: itemId(type === 9 ? "weapon" : "armor", int(p[1])), count: 1 };
      if (p[2]) return { pre: [], cond, swap: false, d: "Degraded", reason: "equipped copies are not counted" };
      return ok(cond);
    }
    case 11:
      return unknown("Degraded", "button state is not readable from events");
    case 12: {
      const r: CondResult = { pre: [], cond: null, swap: false, d: "Placeholder", reason: "script condition not ported; treated as false" };
      r.placeholder = placeholderText(st, "[Script condition not ported:", String(p[1] ?? ""));
      return r;
    }
    case 13:
      return unknown("Degraded", "vehicles not modelled");
    default:
      return unknown("Dropped", "unknown condition type");
  }
}

/** The scope a branch runs in once `cond` is known to hold. */
function narrow(scope: Scope, cond: Condition | null): Scope {
  if (!cond) return scope;
  if (cond.kind === "gold") return { ...scope, gold: Math.max(scope.gold, cond.amount) };
  if (cond.kind === "item") {
    const items = new Map(scope.items);
    items.set(cond.id, Math.max(items.get(cond.id) ?? 0, cond.count));
    return { ...scope, items };
  }
  return scope;
}

function emitBranch(nd: RmNode, st: State, scope: Scope): Command[] {
  const p = nd.cmd.parameters ?? [];
  const r = convertCondition(p, st);
  const key = RM_CONDITION_TYPES[int(p[0], -1)]?.key ?? "unknown";
  st.ctx.cov.record("condition", key, r.d, r.reason);
  rec(st, 111, r.d, r.reason);
  const thenScope = r.swap ? scope : narrow(scope, r.cond);
  const elseScope = r.swap ? narrow(scope, r.cond) : scope;
  const thenCmds = emitList(nd.body ?? [], st, thenScope);
  const elseCmds = nd.elseBody ? emitList(nd.elseBody, st, elseScope) : undefined;
  if (!r.cond) {
    // Unevaluable: the condition is treated as always-false, so the Then
    // can only be entered by a jumpLabel. MV's command119 can jump to any
    // 118 in the flat list, including one inside a conditional branch, so
    // the Then's structure (and its labels) must survive. Fall-through
    // skips the Then via a synthetic jump; a jump into the Then runs it
    // and skips the Else. The condition itself stays Placeholder/Degraded
    // in coverage.
    return deadBranch(st, thenCmds, elseCmds, r.placeholder);
  }
  const out: Command[] = [...r.pre];
  if (r.swap) out.push({ op: "if", if: r.cond, then: elseCmds ?? [], else: thenCmds });
  else if (elseCmds) out.push({ op: "if", if: r.cond, then: thenCmds, else: elseCmds });
  else out.push({ op: "if", if: r.cond, then: thenCmds });
  return out;
}

/** The structure of an unevaluable conditional: the Then is dead code on
 *  fall-through (the condition is always false) but stays reachable by
 *  label. Synthetic jumpLabel/label pairs skip the Then on fall-through
 *  and skip the Else when a jump lands in the Then. The synthetic label
 *  names are unique per conversion (byte-stable re-imports) and avoid every
 *  name the authored list uses for a label or jump target, so an authored
 *  label can never shadow or be shadowed by one. */
function deadBranch(
  st: State,
  thenCmds: Command[],
  elseCmds: Command[] | undefined,
  placeholder: Command[] | undefined,
): Command[] {
  const out: Command[] = [...(placeholder ?? [])];
  if (thenCmds.length === 0) {
    // No Then to preserve: the always-false condition just runs the Else.
    if (elseCmds) out.push(...elseCmds);
    return out;
  }
  // The else/end pair shares an index in the common (collision-free) case;
  // a colliding name advances just that side, keeping the pair's other
  // name stable so re-imports stay byte-identical.
  const n = st.deadBranchSeq++;
  let elseN = n;
  while (st.reservedLabels.has(`__dead_else_${elseN}`)) elseN = st.deadBranchSeq++;
  let endN = n;
  while (st.reservedLabels.has(`__dead_end_${endN}`)) endN = st.deadBranchSeq++;
  const elseLabel = `__dead_else_${elseN}`;
  const endLabel = `__dead_end_${endN}`;
  // Fall-through skips the Then.
  out.push({ op: "jumpLabel", name: elseLabel });
  out.push(...thenCmds);
  if (elseCmds && elseCmds.length > 0) {
    // A jump that landed in the Then skips the Else.
    out.push({ op: "jumpLabel", name: endLabel });
    out.push({ op: "label", name: elseLabel });
    out.push(...elseCmds);
    out.push({ op: "label", name: endLabel });
  } else {
    out.push({ op: "label", name: elseLabel });
  }
  return out;
}

// --- variables, gold, items ------------------------------------------------------

const VARIABLE_OPS = ["set", "add", "sub", "mul", "div", "mod"] as const;
type VarOp = (typeof VARIABLE_OPS)[number];

/** target OP= constant. set/add/sub are direct; mul/div/mod go through a
 *  scratch variable holding the constant. (MV writes Infinity/NaN for a
 *  division or modulo by 0; the kit leaves the target unchanged.) */
function constOp(id: string, op: VarOp, c: number): Command[] {
  if (op === "set" || op === "add" || op === "sub") return [{ op: "variable", id, set: { op, value: c } }];
  const tmp = tempVariableId(1);
  return [
    { op: "variable", id: tmp, set: { op: "set", value: c } },
    { op: "variable", id, set: { op, from: tmp } },
  ];
}

function refOp(id: string, op: VarOp, from: string): Command {
  return { op: "variable", id, set: { op: op === "set" ? "copy" : op, from } };
}

/** Control Variables. MV computes the operand once for the whole range,
 *  except Random, which it draws per variable. MV/MZ do not clamp the
 *  result here; the kit clamps to the safe-integer range. */
function emitVariables(p: readonly unknown[], st: State): Command[] {
  const first = int(p[0]);
  const last = int(p[1]);
  const op = VARIABLE_OPS[int(p[2])];
  if (!op) {
    rec(st, 122, "Dropped", "unknown operation");
    return [];
  }
  const ids: string[] = [];
  for (let n = first; n <= last; n++) ids.push(variableId(n));
  const operand = int(p[3]);
  const out: Command[] = [];
  switch (operand) {
    case 0: {
      for (const id of ids) out.push(...constOp(id, op, int(p[4])));
      rec(st, 122, "Native");
      return out;
    }
    case 1: {
      const srcN = int(p[4]);
      let src = variableId(srcN);
      // The source is read once; inside the target range it would change
      // between targets, so snapshot it.
      if (ids.length > 1 && srcN >= first && srcN <= last) {
        const tmp = tempVariableId(2);
        out.push({ op: "variable", id: tmp, set: { op: "copy", from: src } });
        src = tmp;
      }
      for (const id of ids) out.push(refOp(id, op, src));
      rec(st, 122, "Native");
      return out;
    }
    case 2: {
      const min = int(p[4]);
      const max = int(p[5]);
      const range = { op: "random" as const, min: Math.min(min, max), max: Math.max(min, max) };
      for (const id of ids) {
        if (op === "set") out.push({ op: "variable", id, set: range });
        else {
          const tmp = tempVariableId(1);
          out.push({ op: "variable", id: tmp, set: range }, refOp(id, op, tmp));
        }
      }
      rec(st, 122, "Native");
      return out;
    }
    case 3: {
      const g = gameData(int(p[4]), int(p[5]), int(p[6]), st);
      if ("dropped" in g) {
        rec(st, 122, "Dropped", g.dropped);
        return [];
      }
      if ("value" in g) {
        for (const id of ids) out.push(...constOp(id, op, g.value));
      } else {
        out.push(...g.compute);
        for (const id of ids) out.push(refOp(id, op, g.from));
      }
      rec(st, 122, "Native");
      return out;
    }
    case 4:
      rec(st, 122, "Placeholder", "script operand not ported");
      return placeholderText(st, "[Script not ported:", String(p[4] ?? ""));
    default:
      rec(st, 122, "Dropped", "unknown operand");
      return [];
  }
}

type GameData = { value: number } | { compute: Command[]; from: string } | { dropped: string };

const GAME_DATA_NAMES = ["item", "weapon", "armor", "actor", "enemy", "character", "party", "other", "last"];
const OTHER_NAMES = ["map id", "party size", "gold", "steps", "play time", "timer", "save count", "battle count", "win count", "escape count"];

/** Control Variables' Game Data operand. Item counts and gold are read
 *  exactly with condition trees, timer uses the native timer read, and the
 *  current map id is a constant for a page. Everything else has no kit source. */
function gameData(type: number, a: number, b: number, st: State): GameData {
  if (type >= 0 && type <= 2) {
    // Binary search over 0..99 with `item >= n` tests (MV caps counts at 99).
    const id = itemId(ITEM_KIND[type]!, a);
    const tmp = tempVariableId(1);
    const build = (lo: number, hi: number): Command[] => {
      if (lo === hi) return [{ op: "variable", id: tmp, set: { op: "set", value: lo } }];
      const mid = Math.ceil((lo + hi) / 2);
      return [{ op: "if", if: { kind: "item", id, count: mid }, then: build(mid, hi), else: build(lo, mid - 1) }];
    };
    return { compute: build(0, MAX_ITEM_COUNT), from: tmp };
  }
  if (type === 7 && a === 0) {
    const rmMap = ownerRmMapId(st);
    if (rmMap !== undefined) return { value: rmMap };
    return { dropped: "game data: map id (only known for map event pages)" };
  }
  if (type === 7 && a === 2) {
    // Drain gold into tmp1 bit by bit (gold >= 2^k), then add it back from
    // a copy: the wallet ends unchanged and tmp1 holds the amount.
    const t1 = tempVariableId(1);
    const t2 = tempVariableId(2);
    const drain: Command[] = [{ op: "variable", id: t1, set: { op: "set", value: 0 } }];
    for (let bit = GOLD_BITS - 1; bit >= 0; bit--) {
      const k = 2 ** bit;
      drain.push({
        op: "if",
        if: { kind: "gold", amount: k },
        then: [{ op: "gold", set: "sub", amount: k }, { op: "variable", id: t1, set: { op: "add", value: k } }],
      });
    }
    drain.push({ op: "variable", id: t2, set: { op: "copy", from: t1 } });
    drain.push(...bitsDown(t2, GOLD_BITS, (k) => [{ op: "gold", set: "add", amount: k }]));
    return { compute: drain, from: t1 };
  }
  if (type === 7 && a === 5) {
    const tmp = tempVariableId(1);
    return { compute: [{ op: "timer", action: "read", variable: tmp }], from: tmp };
  }
  const name = type === 7 ? OTHER_NAMES[a] ?? "other" : GAME_DATA_NAMES[type] ?? "unknown";
  return { dropped: `game data: ${name} has no kit source` };
}

/** Subtract powers of two from scratch variable `t`, high bit first,
 *  running `step(k)` for each bit set. */
function bitsDown(t: string, bits: number, step: (k: number) => Command[]): Command[] {
  const out: Command[] = [];
  for (let bit = bits - 1; bit >= 0; bit--) {
    const k = 2 ** bit;
    out.push({
      op: "if",
      if: { kind: "variable", id: t, op: ">=", value: k },
      then: [...step(k), { op: "variable", id: t, set: { op: "sub", value: k } }],
    });
  }
  return out;
}

/** Apply a signed variable amount through constant-amount commands: a
 *  binary decomposition of |v| on a scratch copy. */
function byVariable(
  src: string,
  bits: number,
  pos: (k: number) => Command[],
  neg: (k: number) => Command[],
): Command[] {
  const t = tempVariableId(1);
  return [
    { op: "variable", id: t, set: { op: "copy", from: src } },
    {
      op: "if",
      if: { kind: "variable", id: t, op: ">=", value: 0 },
      then: bitsDown(t, bits, pos),
      else: [
        { op: "variable", id: t, set: { op: "set", value: 0 } },
        { op: "variable", id: t, set: { op: "sub", from: src } },
        ...bitsDown(t, bits, neg),
      ],
    },
  ];
}

/** Change Gold. MV floors gold at 0; the kit's gold can go negative, so a
 *  loss is exact only under an enclosing `gold >= amount` branch. */
function emitGold(p: readonly unknown[], st: State, scope: Scope): Command[] {
  const decrease = int(p[0]) === 1;
  if (int(p[1]) === 1) {
    const add = (k: number): Command[] => [{ op: "gold", set: "add", amount: k }];
    const sub = (k: number): Command[] => [{ op: "gold", set: "sub", amount: k }];
    rec(st, 125, "Degraded", "variable amount lowered to a binary if-chain; losses are not floored at 0");
    return byVariable(variableId(int(p[2])), GOLD_BITS, decrease ? sub : add, decrease ? add : sub);
  }
  const amount = Math.max(0, int(p[2]));
  if (decrease && scope.gold < amount) {
    rec(st, 125, "Degraded", "unguarded loss can take gold below 0 (MV floors it)");
  } else {
    rec(st, 125, "Native");
  }
  return amount > 0 ? [{ op: "gold", set: decrease ? "sub" : "add", amount }] : [];
}

/** Change Items/Weapons/Armors. Weapons and armors share the item bank
 *  ("weapon001", "armor001"). Counts above 99 split into several commands. */
function emitItems(code: number, p: readonly unknown[], st: State, scope: Scope): Command[] {
  const kind = code === 126 ? "item" : code === 127 ? "weapon" : "armor";
  const id = itemId(kind, int(p[0]));
  const decrease = int(p[1]) === 1;
  const set = decrease ? "sub" : "add";
  if (int(p[2]) === 1) {
    const add = (k: number): Command[] => [{ op: "item", item: id, set: "add", count: k }];
    const sub = (k: number): Command[] => [{ op: "item", item: id, set: "sub", count: k }];
    rec(st, code, "Degraded", "variable amount lowered to a binary if-chain; losses are not floored at 0");
    return byVariable(variableId(int(p[3])), ITEM_BITS, decrease ? sub : add, decrease ? add : sub);
  }
  const count = Math.max(0, int(p[3]));
  if (decrease && code !== 126 && p[4]) {
    rec(st, code, "Degraded", "equipped copies are not removed");
  } else if (decrease && (scope.items.get(id) ?? 0) < count) {
    rec(st, code, "Degraded", "unguarded loss can take the count below 0 (MV floors it)");
  } else {
    rec(st, code, "Native");
  }
  const out: Command[] = [];
  for (let left = count; left > 0; left -= MAX_ITEM_COUNT) {
    out.push({ op: "item", item: id, set, count: Math.min(MAX_ITEM_COUNT, left) });
  }
  return out;
}

// --- map and characters --------------------------------------------------------

/** RM character id -> kit route target: -1 player, 0 this event, n a map
 *  event (resolved on the owner's map; by id convention in common events). */
function charTarget(n: number, st: State): RouteTarget | null {
  if (n < 0) return "player";
  const o = st.ctx.owner;
  if (n === 0) return st.eventless ? null : "this";
  if (o.kind === "page") {
    const id = o.eventIds.get(n);
    return id ? { event: id } : null;
  }
  return { event: eventId(n) };
}

/** "This event" in a parallel/autorun common event resolves to no
 *  character in RM, so the command does nothing there. */
function thisWithoutEvent(code: number, p: readonly unknown[], st: State): boolean {
  if (!st.eventless || int(p[0]) !== 0) return false;
  rec(st, code, "Native");
  return true;
}

/** Transfer Player. Direct: one transfer. By variable: the kit's variable
 *  map operand must hold a kit map id (a string), so the importer emits a
 *  binary search over the imported RM map ids on the map variable, with
 *  x/y as variable operands at the leaves. */
function emitTransfer(p: readonly unknown[], st: State): Command[] {
  const dir = DIR_OF[int(p[4])];
  const fadeType = int(p[5]);
  const reasons: string[] = [];
  if (fadeType === 1) reasons.push("white fade shown as black");
  const tail = {
    ...(dir ? { dir } : {}),
    ...(fadeType === 2 ? {} : { fade: TRANSFER_FADE_SECONDS }),
  };
  if (int(p[0]) === 0) {
    const map = st.ctx.maps.get(int(p[1]));
    if (!map) {
      rec(st, 201, "Dropped", "destination map not imported");
      return [];
    }
    rec(st, 201, reasons.length ? "Degraded" : "Native", reasons[0]);
    return [{ op: "transfer", map, x: Math.max(0, int(p[2])), y: Math.max(0, int(p[3])), ...tail }];
  }
  const entries = [...st.ctx.maps].sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) {
    rec(st, 201, "Dropped", "no imported maps");
    return [];
  }
  const v = variableId(int(p[1]));
  const x = { variable: variableId(int(p[2])) };
  const y = { variable: variableId(int(p[3])) };
  const leaf = ([rm, map]: [number, string]): Command => ({
    op: "if",
    if: { kind: "variable", id: v, op: "==", value: rm },
    then: [{ op: "transfer", map, x, y, ...tail }],
  });
  const build = (lo: number, hi: number): Command[] => {
    if (hi - lo < 3) return entries.slice(lo, hi + 1).map(leaf);
    const mid = (lo + hi) >> 1;
    return [{
      op: "if",
      if: { kind: "variable", id: v, op: "<=", value: entries[mid]![0] },
      then: build(lo, mid),
      else: build(mid + 1, hi),
    }];
  };
  rec(st, 201, reasons.length ? "Degraded" : "Native", reasons[0]);
  return build(0, entries.length - 1);
}

/** Scroll Map stores a relative tile distance and the editor's exponential
 * speed level. The runtime derives an exact reference-frame duration, so the
 * importer must not flatten speed into a linear seconds estimate here. */
function emitScrollMap(p: readonly unknown[], st: State): Command[] {
  const direction = DIR_OF[int(p[0])];
  if (!direction) {
    rec(st, 204, "Dropped", "unknown scroll direction");
    return [];
  }
  rec(st, 204, "Native");
  return [{
    op: "scrollMap",
    direction,
    distance: Math.max(0, int(p[1])),
    speed: clamp(int(p[2], 4), 1, 6) as MoveSpeed,
    wait: !!p[3],
  }];
}

/** Set Event Location: direct placement only. */
function emitPlace(p: readonly unknown[], st: State): Command[] {
  if (thisWithoutEvent(203, p, st)) return [];
  const target = charTarget(int(p[0]), st);
  if (!target) {
    rec(st, 203, "Dropped", "no such event");
    return [];
  }
  if (int(p[1]) !== 0) {
    rec(st, 203, "Dropped", int(p[1]) === 1 ? "placement by variables not supported" : "exchange with another event not supported");
    return [];
  }
  rec(st, 203, "Native");
  const dir = DIR_OF[int(p[4])];
  return [{ op: "place", target, x: Math.max(0, int(p[2])), y: Math.max(0, int(p[3])), ...(dir ? { dir } : {}) }];
}

function emitMoveRoute(p: readonly unknown[], st: State): Command[] {
  const charId = int(p[0]);
  const target = charTarget(charId, st);
  const route = p[1] as RmMoveRoute | undefined;
  const speed = charId === 0 ? st.pageSpeed ?? RM_DEFAULT_SPEED : RM_DEFAULT_SPEED;
  if (target && !st.eventless && route?.wait && !route.repeat &&
      route.list.some((mc) => ROUTE_SPLIT_CODES.has(int(mc?.code, -1)))) {
    return emitSplitRoute(route, target, speed, st);
  }
  const r = routeOf(route ?? { list: [], repeat: false, skippable: false, wait: false }, st.ctx, speed);
  if (thisWithoutEvent(205, p, st)) return [];
  if (!target) {
    rec(st, 205, "Dropped", "no such event");
    return [];
  }
  if (r.steps.length === 0) {
    if (r.worst === "Native") rec(st, 205, "Native");
    else rec(st, 205, "Dropped", r.reason ?? "no supported route steps");
    return [];
  }
  if (r.worst === "Native") rec(st, 205, "Native");
  else rec(st, 205, "Degraded", r.reason);
  return [{
    op: "moveRoute",
    target,
    wait: !!route?.wait,
    route: { steps: r.steps, repeat: r.repeat, skippable: r.skippable },
  }];
}

/** Route steps that are really commands (switches, appearance, sound). A
 *  kit route cannot run them, but a waited, non-repeating Set Movement
 *  Route can be split at each of them: route segment (waited), the command,
 *  the next segment. The event already waits for the whole route, so the
 *  order of effects is MV's. */
const ROUTE_SPLIT_CODES: ReadonlySet<number> = new Set([27, 28, 39, 40, 41, 42, 44]);

function emitSplitRoute(route: RmMoveRoute, target: RouteTarget, speed: number, st: State): Command[] {
  const out: Command[] = [];
  let segment: RmMoveCommand[] = [];
  let worst: Disposition = "Native";
  let reason: string | undefined;
  const flush = (): void => {
    if (segment.length === 0) return;
    const r = routeOf({ list: segment, repeat: false, skippable: route.skippable, wait: true }, st.ctx, speed);
    if (RANK[r.worst] > RANK[worst]) {
      worst = r.worst;
      reason = r.reason;
    }
    if (r.steps.length > 0) {
      out.push({ op: "moveRoute", target, wait: true, route: { steps: r.steps, repeat: false, skippable: route.skippable } });
    }
    segment = [];
  };
  for (const mc of route.list) {
    const code = int(mc?.code, -1);
    if (!ROUTE_SPLIT_CODES.has(code)) {
      segment.push(mc);
      continue;
    }
    flush();
    const p = Array.isArray(mc.parameters) ? mc.parameters : [];
    const key = RM_ROUTE_BY_CODE.get(code)?.key ?? `code${code}`;
    st.ctx.cov.record("route", key, "Native");
    switch (code) {
      case 27:
      case 28:
        out.push({ op: "switch", id: switchId(int(p[0])), value: code === 27 });
        break;
      case 39:
      case 40:
        out.push({ op: "appearance", target, visible: code === 40 });
        break;
      case 41: {
        const sprite = st.ctx.sprite({ characterName: String(p[0] ?? ""), characterIndex: int(p[1]), tileId: 0 });
        out.push({ op: "appearance", target, sprite });
        break;
      }
      case 42:
        out.push({ op: "appearance", target, opacity: Math.max(0, Math.min(255, int(p[0]))) });
        break;
      case 44: {
        const audio = p[0] as RmAudio | undefined;
        if (audio?.name) {
          out.push({ op: "playSe", id: st.ctx.audio("se", audio.name), volume: int(audio.volume, 90), pitch: int(audio.pitch, 100) });
        }
        break;
      }
    }
  }
  flush();
  if (worst === "Native") rec(st, 205, "Native");
  else rec(st, 205, "Degraded", reason);
  return out;
}

function emitBalloon(p: readonly unknown[], st: State): Command[] {
  if (thisWithoutEvent(213, p, st)) return [];
  const target = charTarget(int(p[0]), st);
  if (!target) {
    rec(st, 213, "Dropped", "no such event");
    return [];
  }
  const icon = st.ctx.balloon(int(p[1]));
  if (!icon) {
    rec(st, 213, "Dropped", "project has no Balloon.png");
    return [];
  }
  rec(st, 213, "Native");
  return [{ op: "balloon", target, icon, duration: BALLOON_FRAMES / FPS, wait: !!p[2] }];
}

/** Show Animation follows the requested character for the whole effect,
 * matching Sprite_Animation's target binding. MV/MZ use the same character
 * ids as movement routes: -1 player, 0 this event, positive map event. */
function emitAnimation(p: readonly unknown[], st: State): Command[] {
  if (thisWithoutEvent(212, p, st)) return [];
  const target = charTarget(int(p[0]), st);
  if (!target) {
    rec(st, 212, "Dropped", "no such event");
    return [];
  }
  const n = int(p[1]);
  const imported = st.ctx.animation(n);
  if (!imported) {
    rec(st, 212, "Dropped", st.ctx.animationFailure(n) ?? `animation ${n} is not imported`);
    return [];
  }
  rec(st, 212, imported.disposition, imported.reason);
  return [{
    op: "mapAnim",
    id: st.ctx.nextAnimationId(),
    anim: imported.id,
    target,
    wait: !!p[2],
  }];
}

// --- screen and audio -------------------------------------------------------------

/** MV tones add [-255..255] per channel and blend toward grey; the kit
 *  overlays one RGBA colour. The overlay's alpha is the strongest channel
 *  shift and its colour leans each channel the same way; a pure grey tone
 *  becomes a grey veil. Approximate either way. */
export function toneOverlay(tone: readonly unknown[]): ScreenColor {
  const [r, g, b, gray] = [0, 1, 2, 3].map((k) => clamp(int(tone[k]), -255, 255)) as [number, number, number, number];
  const m = Math.max(Math.abs(r), Math.abs(g), Math.abs(b));
  if (m === 0 && gray <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  if (m === 0) return { r: 128, g: 128, b: 128, a: clamp(Math.round(gray / 2), 0, 255) };
  const ch = (t: number): number => clamp(Math.round(128 + (t * 128) / m), 0, 255);
  return { r: ch(r), g: ch(g), b: ch(b), a: clamp(m, 0, 255) };
}

function emitTint(p: readonly unknown[], st: State): Command[] {
  const tone = Array.isArray(p[0]) ? (p[0] as unknown[]) : [];
  const color = toneOverlay(tone);
  if (color.a === 0) rec(st, 223, "Native");
  else rec(st, 223, "Degraded", "colour tone approximated as an overlay colour");
  return [{ op: "screenTint", layer: TONE_LAYER, color, duration: seconds(p[1]), wait: !!p[2] }];
}

function waitCommands(total: number): Command[] {
  const out: Command[] = [];
  for (let left = total; left > 1e-9; left -= MAX_WAIT_SECONDS) {
    out.push({ op: "wait", seconds: Math.min(MAX_WAIT_SECONDS, left) });
  }
  return out;
}

const pictureOrigin = (v: unknown): PictureOrigin => int(v) === 1 ? "center" : "topLeft";
const pictureBlend = (v: unknown): PictureBlendMode => PICTURE_BLEND[int(v)] ?? "normal";

/** Picture x/y are either literal viewport pixels or variable ids sampled
 * when the command executes. `designation` is parameter 3 for both Show and
 * Move Picture; x/y are parameters 4/5. */
function pictureCoordinates(p: readonly unknown[]): [PictureCoordinate, PictureCoordinate] {
  if (int(p[3]) === 1) {
    return [{ variable: variableId(int(p[4])) }, { variable: variableId(int(p[5])) }];
  }
  return [int(p[4]), int(p[5])];
}

function pictureTone(v: unknown): PictureTone {
  const tone = Array.isArray(v) ? v : [];
  return {
    r: clamp(int(tone[0]), -255, 255),
    g: clamp(int(tone[1]), -255, 255),
    b: clamp(int(tone[2]), -255, 255),
    gray: clamp(int(tone[3]), 0, 255),
  };
}

function emitShowPicture(p: readonly unknown[], st: State): Command[] {
  const name = String(p[1] ?? "");
  if (name === "") {
    rec(st, 231, "Dropped", "picture without an image");
    return [];
  }
  const [x, y] = pictureCoordinates(p);
  rec(st, 231, "Native");
  return [{
    op: "showPicture",
    id: int(p[0]),
    layer: PICTURE_LAYER,
    variant: st.ctx.picture(name),
    origin: pictureOrigin(p[2]),
    x,
    y,
    scaleX: num(p[6], 100),
    scaleY: num(p[7], 100),
    opacity: clamp(int(p[8], 255), 0, 255),
    blend: pictureBlend(p[9]),
  }];
}

function emitMovePicture(p: readonly unknown[], st: State): Command[] {
  const [x, y] = pictureCoordinates(p);
  const easing = PICTURE_EASING[int(p[12])] ?? "linear";
  rec(st, 232, "Native");
  return [{
    op: "movePicture",
    id: int(p[0]),
    origin: pictureOrigin(p[2]),
    x,
    y,
    scaleX: num(p[6], 100),
    scaleY: num(p[7], 100),
    opacity: clamp(int(p[8], 255), 0, 255),
    blend: pictureBlend(p[9]),
    duration: seconds(p[10]),
    wait: !!p[11],
    ...(st.ctx.rm.flavor === "MZ" ? { easing } : {}),
  }];
}

function emitTintPicture(p: readonly unknown[], st: State): Command[] {
  rec(st, 234, "Native");
  return [{
    op: "tintPicture",
    id: int(p[0]),
    tone: pictureTone(p[1]),
    duration: seconds(p[2]),
    wait: !!p[3],
  }];
}

function emitAudio(code: number, a: RmAudio | undefined, st: State): Command[] {
  const name = typeof a?.name === "string" ? a.name : "";
  const volume = clamp(Math.round(num(a?.volume, 90)), 0, 100);
  const pitch = clamp(Math.round(num(a?.pitch, 100)), 50, 150);
  const panned = num(a?.pan, 0) !== 0;
  const native = (): void => {
    if (panned) rec(st, code, "Degraded", "audio pan ignored");
    else rec(st, code, "Native");
  };
  switch (code) {
    case 241:
      // An empty BGM name stops the BGM (AudioManager.playBgm).
      if (name === "") {
        rec(st, 241, "Native");
        return [{ op: "stopBgm" }];
      }
      native();
      return [{ op: "playBgm", id: st.ctx.audio("bgm", name), volume, pitch }];
    case 245:
      if (name === "") {
        rec(st, 245, "Native");
        return [{ op: "fadeoutBgs", duration: 0 }];
      }
      native();
      return [{ op: "playBgs", id: st.ctx.audio("bgs", name), volume, pitch }];
    case 249:
      if (name === "") {
        rec(st, 249, "Dropped", "stopping an ME is not supported");
        return [];
      }
      rec(st, 249, "Degraded", `ME length unknown; plays for ${ME_DEFAULT_SECONDS} s`);
      return [{ op: "playMe", id: st.ctx.audio("me", name), duration: ME_DEFAULT_SECONDS, volume, pitch }];
    default:
      if (name === "") {
        rec(st, 250, "Native");
        return [];
      }
      native();
      return [{ op: "playSe", id: st.ctx.audio("se", name), volume, pitch }];
  }
}

// --- battle, shop, name input --------------------------------------------------------

/** Battle Processing. The kit has no RPG Maker battle system: the setup
 *  JSON names the troop for a game-registered (placeholder) battle, and the
 *  If Win / If Escape / If Lose branches map to onWin / onEscape / onLose. */
function emitBattle(nd: RmNode, p: readonly unknown[], st: State, scope: Scope): Command[] {
  const desig = int(p[0]);
  const troopN = int(p[1]);
  const setup: { [key: string]: JsonValue } = { system: "rpgmaker", canEscape: !!p[2], canLose: !!p[3] };
  if (desig === 0) {
    setup.troop = troopN;
    setup.name = st.ctx.rm.troops[troopN]?.name ?? "";
  } else if (desig === 1) {
    setup.troopVariable = variableId(troopN);
  } else {
    setup.encounter = true;
  }
  const cmd: Extract<Command, { op: "battle" }> = { op: "battle", setup };
  for (const br of nd.branches ?? []) {
    const cmds = emitList(br.body, st, scope);
    if (br.marker.code === 601) cmd.onWin = cmds;
    else if (br.marker.code === 602) cmd.onEscape = cmds;
    else cmd.onLose = cmds;
  }
  rec(st, 301, "Placeholder", "no RPG Maker battle system; the game runs a placeholder battle");
  return [cmd];
}

function emitShop(nd: RmNode, p: readonly unknown[], st: State): Command[] {
  const rows = [p, ...nd.lines.map((l) => l.parameters ?? [])];
  const goods: ShopGood[] = [];
  for (const r of rows) {
    const kind = ITEM_KIND[int(r[0])];
    if (!kind || int(r[1]) <= 0) continue;
    const good: ShopGood = { item: itemId(kind, int(r[1])) };
    if (int(r[2]) === 1) good.price = Math.max(0, int(r[3]));
    goods.push(good);
  }
  if (goods.length === 0) {
    rec(st, 302, "Dropped", "shop without goods");
    return [];
  }
  rec(st, 302, "Native");
  const cmd: Extract<Command, { op: "shop" }> = { op: "shop", id: st.ctx.nextShopId(), goods };
  if (p[4]) cmd.sell = false;
  return [cmd];
}

/** Name Input Processing opens the kit's built-in name-input scene. Actor 1
 *  is the player name (the {name} token); MV's Scene_Name cannot be
 *  cancelled, hence swallowCancel. Other actors' names have no token: the
 *  entry is kept in a variable. */
function emitNameInput(p: readonly unknown[], st: State): Command[] {
  const actor = int(p[0]);
  const args: { [key: string]: JsonValue } = { maxLength: clamp(int(p[1], 8), 1, 24), swallowCancel: true };
  if (actor === 1) {
    rec(st, 303, "Native");
  } else {
    args.variable = `actor${String(actor).padStart(3, "0")}-name`;
    rec(st, 303, "Degraded", "only actor 1's name is shown in text; other names go to a variable");
  }
  const name = st.ctx.rm.actors[actor]?.name;
  if (name) args.title = name.slice(0, 24);
  return [{ op: "scene", id: NAME_INPUT_SCENE_ID, args }];
}

// --- placeholders ---------------------------------------------------------------

function placeholderText(st: State, head: string, detail: string): Command[] {
  if (st.ctx.placeholders !== "visible") return [];
  const snippet = detail.replace(/\s+/g, " ").trim().slice(0, 40);
  return [{ op: "text", lines: [head, `${snippet}]`] }];
}

/** Script (355/655), MV Plugin Command (356), MZ Plugin Command (357/657):
 *  always a placeholder; visible mode shows a message naming it. */
function emitPlaceholder(nd: RmNode, p: readonly unknown[], st: State): Command[] {
  const code = nd.cmd.code;
  if (code === 355) {
    const src = [String(p[0] ?? ""), ...nd.lines.map((l) => String(l.parameters?.[0] ?? ""))].join(" ");
    rec(st, 355, "Placeholder", "script not ported");
    return placeholderText(st, "[Script not ported:", src);
  }
  const name = code === 356 ? String(p[0] ?? "") : `${String(p[0] ?? "")}:${String(p[1] ?? "")}`;
  rec(st, code, "Placeholder", "plugin command not ported");
  return placeholderText(st, "[Plugin command not ported:", name);
}

// --- self switches ------------------------------------------------------------------

function isSelfKey(k: unknown): k is "A" | "B" | "C" | "D" {
  return k === "A" || k === "B" || k === "C" || k === "D";
}

/** The kit stores one self-switch letter per event (setting B clears A);
 *  RM has four independent ones. Exact only when an event uses one letter. */
function eventUsesSeveralSelfSwitches(st: State): boolean {
  if (st.selfMulti !== undefined) return st.selfMulti;
  let multi = false;
  const o = st.ctx.owner;
  if (o.kind === "page") {
    const rmMap = ownerRmMapId(st);
    let rmEvent: number | undefined;
    for (const [rm, kit] of o.eventIds) if (kit === o.eventId) rmEvent = rm;
    const ev = rmMap !== undefined && rmEvent !== undefined ? st.ctx.rm.maps.get(rmMap)?.events[rmEvent] : undefined;
    if (ev) {
      const keys = new Set<string>();
      for (const pg of ev.pages ?? []) {
        if (pg.conditions?.selfSwitchValid) keys.add(pg.conditions.selfSwitchCh);
        for (const c of pg.list ?? []) {
          if (c.code === 123) keys.add(String(c.parameters?.[0]));
          if (c.code === 111 && c.parameters?.[0] === 2) keys.add(String(c.parameters[1]));
        }
      }
      multi = keys.size > 1;
    }
  }
  st.selfMulti = multi;
  return multi;
}

// --- move routes --------------------------------------------------------------------

interface RouteResult {
  steps: MoveStep[];
  repeat: boolean;
  skippable: boolean;
  worst: Disposition;
  reason?: string;
}

const RANK: Record<Disposition, number> = { Native: 0, Degraded: 1, Placeholder: 2, Dropped: 3 };

const ROUTE_DROPPED: Readonly<Record<number, string>> = {
  11: "needs a step-away move",
  13: "needs a backward step",
  14: "needs a jump step",
  20: "needs relative turns",
  21: "needs relative turns",
  22: "needs relative turns",
  23: "needs relative turns",
  26: "needs a turn-away step",
  27: "needs a switch step inside routes",
  28: "needs a switch step inside routes",
  31: "walking animation toggle not modelled",
  32: "walking animation toggle not modelled",
  33: "stepping animation toggle not modelled",
  34: "stepping animation toggle not modelled",
  39: "needs an appearance step inside routes",
  40: "needs an appearance step inside routes",
  41: "needs an appearance step inside routes",
  42: "needs an appearance step inside routes",
  43: "blend modes not supported",
  44: "needs a sound step inside routes",
  45: "script not ported",
};

const DIAGONAL: Readonly<Record<number, [MoveStep, MoveStep]>> = {
  5: ["moveDown", "moveLeft"],
  6: ["moveDown", "moveRight"],
  7: ["moveUp", "moveLeft"],
  8: ["moveUp", "moveRight"],
};

/** Convert route steps, recording each in the "route" section. `speed` is
 *  the mover's RM speed, which route waits are measured against: a kit
 *  `wait` step lasts one step at the mover's speed, 2^(8-speed) frames
 *  (16 at speed 4), like an RM move. */
function routeOf(route: RmMoveRoute, ctx: EventContext, speed: number): RouteResult {
  const steps: MoveStep[] = [];
  let worst: Disposition = "Native";
  let reason: string | undefined;
  const note = (key: string, d: Disposition, why?: string): void => {
    ctx.cov.record("route", key, d, why);
    if (RANK[d] > RANK[worst]) {
      worst = d;
      reason = why;
    }
  };
  let curSpeed = speed;
  for (const mc of (route?.list ?? []) as RmMoveCommand[]) {
    const code = int(mc?.code, -1);
    if (code === 0) continue;
    const p = Array.isArray(mc.parameters) ? mc.parameters : [];
    const key = RM_ROUTE_BY_CODE.get(code)?.key ?? `code${code}`;
    switch (code) {
      case 1: steps.push("moveDown"); note(key, "Native"); break;
      case 2: steps.push("moveLeft"); note(key, "Native"); break;
      case 3: steps.push("moveRight"); note(key, "Native"); break;
      case 4: steps.push("moveUp"); note(key, "Native"); break;
      case 5:
      case 6:
      case 7:
      case 8:
        steps.push(...DIAGONAL[code]!);
        note(key, "Degraded", "diagonal step lowered to two orthogonal steps");
        break;
      case 9:
        // Game_Character.moveRandom only turns when the step succeeds and
        // picks a new direction on each retry; the kit turns, then retries
        // the same direction.
        steps.push("turnRandom", "stepForward");
        note(key, "Degraded", "random move turns even when blocked and retries one direction");
        break;
      case 10:
        // moveTowardCharacter steps along the dominant axis (vertical on a
        // tie, like the kit's turnToward) and tries the other axis when
        // blocked; the lowering has no fallback axis.
        steps.push("turnTowardPlayer", "stepForward");
        note(key, "Degraded", "step toward the player has no blocked-axis fallback");
        break;
      case 12: steps.push("stepForward"); note(key, "Native"); break;
      case 15: {
        const frames = Math.max(0, int(p[0]));
        const per = 2 ** (8 - curSpeed);
        const count = frames === 0 ? 0 : Math.max(1, Math.round(frames / per));
        for (let k = 0; k < count; k++) steps.push("wait");
        if (frames % per === 0) note(key, "Native");
        else note(key, "Degraded", "route wait rounded to whole step lengths");
        break;
      }
      case 16: steps.push("faceDown"); note(key, "Native"); break;
      case 17: steps.push("faceLeft"); note(key, "Native"); break;
      case 18: steps.push("faceRight"); note(key, "Native"); break;
      case 19: steps.push("faceUp"); note(key, "Native"); break;
      case 24: steps.push("turnRandom"); note(key, "Native"); break;
      case 25: steps.push("turnTowardPlayer"); note(key, "Native"); break;
      case 29: {
        curSpeed = clamp(int(p[0], 4), 1, 6);
        steps.push({ control: { kind: "speed", value: curSpeed as MoveSpeed } });
        note(key, "Native");
        break;
      }
      case 30:
        steps.push({ control: { kind: "frequency", value: clamp(int(p[0], 3), 1, 5) as MoveFrequency } });
        note(key, "Native");
        break;
      case 35:
      case 36:
        steps.push({ control: { kind: "directionFix", value: code === 35 } });
        note(key, "Native");
        break;
      case 37:
      case 38:
        steps.push({ control: { kind: "through", value: code === 37 } });
        note(key, "Native");
        break;
      default:
        note(key, "Dropped", ROUTE_DROPPED[code] ?? "unknown route command");
    }
  }
  return { steps, repeat: !!route?.repeat, skippable: !!route?.skippable, worst, reason };
}
