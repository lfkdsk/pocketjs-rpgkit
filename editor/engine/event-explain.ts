// editor/engine/event-explain.ts — a deterministic, human-readable summary of
// an event: how it triggers, each page's condition and command order, and the
// state it changes (switches, self switches, variables, items, gold, map
// transfers, common events). Pure (no DOM, no store): a GameEvent goes in and
// an EventExplanation comes out, so the inspector renders it and tests assert
// on it without a browser. No model is called; the command tree alone decides
// everything, so the same event always explains the same way.
//
// Text is never shortened here: the panel wraps lines itself, and a summary
// that dropped the tail of a long message would hide what the event actually
// says. The compact 64-character commandSummary stays the default for list
// rows and hover cards; this module asks for the full text explicitly.

import type { Command, GameEvent, Trigger } from "../../src/engine/types.ts";
import { flattenCommands, pageConditionSummary } from "./commands.ts";

export interface ExplainStep {
  /** Nesting depth in the command tree (0 = the page root list). */
  depth: number;
  summary: string;
  /** Set when this command starts a branch body (Then, Else, Option 1…). */
  branch?: string;
}

export interface ExplainPage {
  index: number;
  trigger: string;
  /** Human-readable condition; "Always" when the page has none. */
  condition: string;
  /** Commands on the page, branch bodies included. */
  commandCount: number;
  /** The page's commands in execution (pre-order) sequence. */
  steps: ExplainStep[];
}

export interface EventExplanation {
  /** The first page's trigger, as the event's headline trigger. */
  trigger: string;
  pages: ExplainPage[];
  /** Distinct switch ids this event sets, sorted. */
  switches: string[];
  /** Distinct self-switch keys (A–D) this event sets, sorted. */
  selfSwitches: string[];
  /** Distinct variable ids this event writes, sorted. */
  variables: string[];
  /** Item ids this event gives or takes, with the direction. */
  items: { id: string; direction: "gains" | "loses" }[];
  /** Whether the party's gold goes up, down, both, or not at all. */
  gold: "gains" | "loses" | "both" | null;
  /** Literal map ids this event transfers the player to, sorted. A
   *  variable-target transfer is not listed (it cannot be resolved here). */
  transfers: string[];
  /** Distinct common event ids this event calls, sorted. */
  commonEvents: string[];
  /** Whether at least one command is classified as a static write. The
   *  digest's "changes no …" claim is gated on this (together with
   *  `runtimeWrites`), not on whether the display fragments came out empty,
   *  so a static write with an empty-string or missing target can never
   *  produce a false no-change claim. */
  writesStatically: boolean;
  /** Channels through which a command can rewrite state at runtime — the
   *  game owns the handler/reducer (or the target is read from a variable),
   *  so the static explanation cannot name the affected ids. Sorted,
   *  distinct. Present so the digest never claims "changes no …" for an
   *  event whose `ext`/`extChoice`/`battle`/`scene`/`shop` command, or a
   *  variable-target `transfer`, may write variables, switches, items, gold
   *  or transfer the player when it resolves. */
  runtimeWrites: string[];
}

const TRIGGER_WORDS: Record<Trigger, string> = {
  action: "Runs when the player confirms facing it",
  playerTouch: "Runs when the player walks onto it",
  // Mirrors the engine contract in src/engine/types.ts: on a blocking page
  // Event Touch fires on a bump (the player's step refused by the event, or
  // the event's step refused by the player); on a non-blocking page it fires
  // on entry like playerTouch.
  eventTouch: "Runs when the player bumps into it or it bumps into the player; on a non-blocking page, when the player walks onto it",
  autorun: "Runs automatically while its page is active, taking over the screen",
  parallel: "Runs automatically in the background while its page is active",
};

export function explainTrigger(trigger: Trigger): string {
  return TRIGGER_WORDS[trigger] ?? `Runs on ${trigger}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Code-point order, so the explanation is identical on every host regardless
 *  of the platform's default collation. */
function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Every command op that writes one or more event variables. The union of
 *  `Extract<Command, { variable: string }>["op"]` (the read-into-a-variable
 *  family), the `variable` command itself (which names its target via `id`)
 *  and `extChoice` (whose `write` sinks are variable ids). When a new command
 *  with a variable write target joins the Command union, VariableWriteOp
 *  grows and the assertion below fails to compile until the op is listed here
 *  and handled by collectCommandEffect. */
type VariableWriteOp = Extract<Command, { variable: string }>["op"] | "variable" | "extChoice";

export const VARIABLE_WRITE_OPS = [
  "variable",
  "timer",
  "inputNumber",
  "selectItem",
  "locationInfo",
  "extChoice",
] as const satisfies readonly VariableWriteOp[];

type AssertNoMissing<T extends never> = T;
type _AllVariableWritesListed = AssertNoMissing<Exclude<VariableWriteOp, (typeof VARIABLE_WRITE_OPS)[number]>>;

interface Effects {
  switches: Set<string>;
  selfSwitches: Set<string>;
  variables: Set<string>;
  items: Map<string, "gains" | "loses">;
  gold: "gains" | "loses" | "both" | null;
  transfers: Set<string>;
  commonEvents: Set<string>;
  runtimeWrites: Set<string>;
  writesStatically: boolean;
}

function newEffects(): Effects {
  return { switches: new Set(), selfSwitches: new Set(), variables: new Set(), items: new Map(), gold: null, transfers: new Set(), commonEvents: new Set(), runtimeWrites: new Set(), writesStatically: false };
}

/** How a command's effect on the digest channels (switches, self switches,
 *  variables, items, gold, map transfers, common-event calls) can be known
 *  from the command tree alone:
 *  - `static`: the command names a concrete target (a switch id, a variable
 *    id, an item, a literal map, a common event), so the explanation lists
 *    the id.
 *  - `runtime`: whether state changes, or which ids it touches, is decided at
 *    runtime by a game-owned handler/reducer or a variable read, so the
 *    explanation can name the channel but not the affected ids.
 *  - `none`: the command writes none of the digest channels.
 *  The switch in `classifyCommand` is exhaustive over the Command union: a
 *  new op that joins the union fails the `never` assertion there until it is
 *  classified, so the digest can never again silently call a state-changing
 *  command "no change". */
/** The digest channels a runtime-decided write can flow through. A closed
 *  union so consumers (the digest, the doctor's probe-fallback note) can be
 *  exhaustive over it: a newly classified channel fails their `Record`
 *  checks until it is handled everywhere. */
export type RuntimeChannel =
  | "extension command"
  | "extension choice"
  | "battle"
  | "scene"
  | "shop"
  | "variable-target transfer";

export type CommandWriteClass =
  | { kind: "none" }
  | { kind: "static" }
  | { kind: "runtime"; channel: RuntimeChannel };

/** Whether a transfer names its destination map by a variable (resolved at
 *  runtime) rather than a literal id. */
function isVariableTargetTransfer(command: Extract<Command, { op: "transfer" }>): boolean {
  return typeof command.map !== "string";
}

/** Classify every command op exhaustively. The `never` assertion in the
 *  default branch fails to compile when a new op joins the Command union
 *  until it is classified here, so a state-changing command can never slip
 *  through as "no change". A `runtime` result carries the digest channel
 *  name ("shop", "battle", …) shown to the user. */
export function classifyCommand(command: Command): CommandWriteClass {
  switch (command.op) {
    // Statically-nameable writes: the command names its target, so the
    // explanation lists the concrete id.
    case "switch":
    case "selfSwitch":
    case "variable":
    case "inputNumber":
    case "selectItem":
    case "locationInfo":
    case "item":
    case "gold":
    case "common":
      return { kind: "static" };
    case "timer":
      // Only `read` sinks the remaining seconds into a variable; start/stop
      // write no digest channel.
      return command.action === "read" ? { kind: "static" } : { kind: "none" };
    case "extChoice":
      // Its static `write` field names variables (collected separately); its
      // resolver may return more writes at runtime.
      return { kind: "runtime", channel: "extension choice" };
    case "transfer":
      // A literal map is a static destination; a variable reference is
      // resolved at runtime and cannot be named here.
      return isVariableTargetTransfer(command)
        ? { kind: "runtime", channel: "variable-target transfer" }
        : { kind: "static" };
    // Writes decided at runtime by a game-owned handler/reducer: the static
    // explanation can name the channel but not the affected ids. `ext`
    // handlers return writes/items/gold; `battle` and `scene` completions may
    // return writes, switches, items, gold or a transfer; `shop` changes
    // items and gold when the player buys or sells.
    case "ext":
      return { kind: "runtime", channel: "extension command" };
    case "battle":
      return { kind: "runtime", channel: "battle" };
    case "scene":
      return { kind: "runtime", channel: "scene" };
    case "shop":
      return { kind: "runtime", channel: "shop" };
    // Everything else writes no digest channel (presentation, audio, camera,
    // pictures, control flow, input locks, placement, …).
    case "text":
    case "choices":
    case "if":
    case "moveRoute":
    case "moveControl":
    case "appearance":
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
    case "openMenu":
    case "openSave":
    // Like openSave, a host-owned request: it asks the host to write the
    // autosave slot and changes no reducer state (without a host it is a
    // deterministic no-op), so it writes no digest channel.
    case "autosave":
    case "gameOver":
    case "returnTitle":
    case "changeName":
    case "mapNameDisplay":
    case "menuAccess":
    case "saveAccess":
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
    case "erase":
    case "exit":
    case "loop":
    case "break":
    case "label":
    case "jumpLabel":
    case "mapAnim":
    case "stopAnim":
    case "lockInput":
    case "unlockInput":
    case "place":
      return { kind: "none" };
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

function collectVariableWrite(command: Command & Record<string, unknown>, into: Effects): void {
  switch (command.op) {
    case "variable":
      // An empty id is schema-invalid, but Explain runs on any openable
      // document; the classification gate (writesStatically) keeps the
      // digest truthful even when the target cannot be named.
      if (typeof command.id === "string") into.variables.add(command.id);
      break;
    case "timer":
      // Only `read` sinks the remaining seconds into a variable; start/stop
      // do not write one.
      if (command.action === "read" && typeof command.variable === "string") {
        into.variables.add(command.variable);
      }
      break;
    case "inputNumber":
    case "selectItem":
    case "locationInfo":
      if (typeof command.variable === "string") into.variables.add(command.variable);
      break;
    case "extChoice":
      if (isRecord(command.write)) {
        for (const field of ["index", "key", "cancelled"] as const) {
          const id = command.write[field];
          if (typeof id === "string") into.variables.add(id);
        }
      }
      break;
    default:
      break;
  }
}

function collectCommandEffect(command: Command, into: Effects): void {
  const value = command as Command & Record<string, unknown>;
  const effect = classifyCommand(command);
  if (effect.kind === "runtime") into.runtimeWrites.add(effect.channel);
  else if (effect.kind === "static") into.writesStatically = true;
  switch (value.op) {
    case "switch":
      // Schema-valid ids are non-empty, but an empty string is still a
      // string target: collect it (shown as an empty id) rather than let a
      // state-changing command vanish from the digest.
      if (typeof value.id === "string") into.switches.add(value.id);
      break;
    case "selfSwitch":
      if (typeof value.key === "string") into.selfSwitches.add(value.key);
      break;
    case "item": {
      if (typeof value.item !== "string") break;
      const direction = value.set === "sub" ? "loses" : "gains";
      const prior = into.items.get(value.item);
      into.items.set(value.item, prior && prior !== direction ? "loses" : direction);
      break;
    }
    case "gold": {
      const direction = value.set === "sub" ? "loses" : "gains";
      into.gold = into.gold === null ? direction : into.gold === direction ? direction : "both";
      break;
    }
    case "transfer":
      // A literal map id is a static destination; a variable reference is
      // resolved at runtime and cannot be named here.
      if (typeof value.map === "string") into.transfers.add(value.map);
      break;
    case "common":
      if (typeof value.id === "string") into.commonEvents.add(value.id);
      break;
    default:
      break;
  }
  collectVariableWrite(value, into);
}

/** Build a deterministic explanation of an event from its command tree. */
export function explainEvent(event: GameEvent): EventExplanation {
  const effects = newEffects();
  const pages: ExplainPage[] = event.pages.map((page, index) => {
    const rows = flattenCommands(page.commands, { fullSummary: true });
    for (const row of rows) collectCommandEffect(row.command, effects);
    return {
      index,
      trigger: explainTrigger(page.trigger),
      condition: pageConditionSummary(page.condition, { full: true }),
      commandCount: rows.length,
      steps: rows.map((row) => ({
        depth: row.depth,
        summary: row.summary,
        ...(row.branchLabel === undefined ? {} : { branch: row.branchLabel }),
      })),
    };
  });
  return {
    trigger: pages[0]?.trigger ?? explainTrigger("action"),
    pages,
    switches: sorted(effects.switches),
    selfSwitches: sorted(effects.selfSwitches),
    variables: sorted(effects.variables),
    items: [...effects.items.entries()]
      .map(([id, direction]) => ({ id, direction }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    gold: effects.gold,
    transfers: sorted(effects.transfers),
    commonEvents: sorted(effects.commonEvents),
    runtimeWrites: sorted(effects.runtimeWrites),
    writesStatically: effects.writesStatically,
  };
}

/** The page head line: its own trigger (every page shows how it starts),
 *  condition and command count. */
export function explainPageHeadline(page: ExplainPage): string {
  return `Page ${page.index + 1} · ${page.trigger} · ${page.condition} · ${page.commandCount} command${page.commandCount === 1 ? "" : "s"}`;
}

/** Render an id in the digest, making an empty-string target visible
 *  instead of letting it vanish into the surrounding text. */
function showId(id: string): string {
  return id === "" ? '""' : id;
}

/** A one-line "what this event changes" digest for lists and hover cards.
 *  Static writes are named; runtime-decided channels (ext/extChoice/battle/
 *  scene/shop, whose handler or reducer owns the actual ids, and a
 *  variable-target transfer whose map is read at runtime) are named as a
 *  possibility. The digest only claims "changes no …" when every command is
 *  classified `none` and no static target was collected — the gate is the
 *  classification, not whether the display fragments came out empty, so a
 *  static write with an empty-string or missing target can never produce a
 *  false no-change claim. */
export function explainEffectsDigest(explanation: EventExplanation): string {
  const parts: string[] = [];
  if (explanation.switches.length) parts.push(`sets switch${explanation.switches.length === 1 ? "" : "es"} ${explanation.switches.map(showId).join(", ")}`);
  if (explanation.selfSwitches.length) parts.push(`sets self switch${explanation.selfSwitches.length === 1 ? "" : "es"} ${explanation.selfSwitches.map(showId).join(", ")}`);
  if (explanation.variables.length) parts.push(`writes variable${explanation.variables.length === 1 ? "" : "s"} ${explanation.variables.map(showId).join(", ")}`);
  if (explanation.items.length) parts.push(explanation.items.map((item) => `${item.direction === "loses" ? "loses" : "gives"} item ${showId(item.id)}`).join("; "));
  if (explanation.gold) parts.push(explanation.gold === "both" ? "changes gold both ways" : explanation.gold === "loses" ? "loses gold" : "gains gold");
  if (explanation.transfers.length) parts.push(`transfers to ${explanation.transfers.map(showId).join(", ")}`);
  if (explanation.commonEvents.length) parts.push(`calls common event${explanation.commonEvents.length === 1 ? "" : "s"} ${explanation.commonEvents.map(showId).join(", ")}`);
  if (explanation.runtimeWrites.length) {
    const channels = explanation.runtimeWrites.join(", ");
    parts.push(parts.length === 0
      ? `may change state via runtime-decided ${channels} results`
      : `may also change state via runtime-decided ${channels} results`);
  }
  if (parts.length) return parts.join("; ");
  // A static-classified command whose target cannot be named (a malformed
  // document with a missing target field) still writes state.
  if (explanation.writesStatically) return "changes state through a command whose target is not named";
  return "changes no switches, variables, items or maps";
}
