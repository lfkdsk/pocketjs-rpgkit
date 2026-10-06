// tools/rpgkit-check/src/lint.ts — static health checks for an
// rpgkit-project/v1 document. Every check is a pure function of the
// document: no session, no simulation. The dynamic checks (locks, freeze,
// reach, explore) live in src/dynamic/.
//
// Checks:
//   lint/switch-read-never-set      switch read by a condition but never set
//   lint/switch-set-never-read      switch set but never read
//   lint/variable-read-never-set    variable read but never set (may be seeded
//                                   by a save/extension — info, not error)
//   lint/variable-set-never-read    variable set but never read
//   lint/selfswitch-read-never-set  page requires a self switch TRUE that no
//                                   page of the event (nor a common event it
//                                   calls) ever sets → the page can never win
//   lint/page-condition-contradiction  page condition provably false
//   lint/page-shadowed              an earlier page's condition implies a
//                                   later page's, so the earlier never wins
//   lint/start-map-missing          start map absent or start out of bounds
//   lint/transfer-target-missing    transfer to an unknown map or out of bounds
//   lint/place-target-missing       place of an unknown event or out of bounds
//   lint/route-target-missing       moveRoute at an unknown event
//   lint/appearance-target-missing  appearance command targets an event not
//                                   on the host map
//   lint/common-event-missing       common op to an unknown common event
//   lint/item-missing               item/shop/condition reference to an item
//                                   not in the catalog
//   lint/audio-missing              audio command/condition id absent from a
//                                   declared project.audio table (warning:
//                                   partial tables and typos are both shown)
//   lint/sprite-missing             page.sprite / appearance.sprite /
//                                   choices option icon.sprite key not in
//                                   project.sprites
//   lint/sheet-missing              map.sheets / tile id / item sprite
//                                   referencing an unknown tile sheet
//   lint/tileproperty-out-of-bounds  tileProperty command outside the host
//                                   map's bounds (the runtime throws)
//   lint/map-unreachable            map not reachable from the start map by
//                                   any sequence of literal-id transfers
//                                   (dynamic/variable transfers can still
//                                   reach it; the reach check proves it from
//                                   real state)
//   lint/choices-empty              choices with no options and no cancel —
//                                   a modal that can never be dismissed
//   lint/scene-id                   a scene id used by the document; scene
//                                   rules are code-side, so the id is listed
//                                   for a registration review (info)
//   lint/text-variable-token-off    a text/choices string carries `{v:<id>}`
//                                   but system.textVariables is off, so the
//                                   token prints verbatim (warning). With it
//                                   on, each token counts as a variable READ
//   lint/break-outside-loop         a `break` not inside any `loop` body: it
//                                   ends the page / common event (legal, RPG
//                                   Maker parity) — listed for review (info)

import type {
  Command,
  Condition,
  GameEvent,
  MapDef,
  PageCondition,
  Project,
} from "../../../src/engine/types.ts";
import type { SelfKey } from "../../../src/engine/interpreter.ts";
import { structuralFindings } from "./structure.ts";
import { makeFinding, type CheckReport, type Finding, type FindingLocation } from "./finding.ts";
import {
  conditionContradiction,
  conditionImplies,
  flattenPageCondition,
} from "./conditions.ts";
import { walkCommands, walkProjectCommands } from "./walk.ts";

interface Usage {
  reads: FindingLocation[];
  writes: FindingLocation[];
}

/** Exported for the incremental cache's usage digests. */
export type { Usage };

/** A per-map usage record: every switch/variable the map reads or writes
 *  (with its first location in the map), the scene ids it uses, the common
 *  events it calls directly, and its literal transfer edges. The
 *  incremental cache stores one per shard so a map's contribution survives
 *  other maps being re-checked. */
export interface UsageSink {
  switches: Map<string, Usage>;
  variables: Map<string, Usage>;
  scenes: Map<string, FindingLocation>;
  commonCalls: string[];
  edges: Set<string>;
}

export function createUsageSink(): UsageSink {
  return {
    switches: new Map(),
    variables: new Map(),
    scenes: new Map(),
    commonCalls: [],
    edges: new Set(),
  };
}


/** `{v:<id>}` text tokens (src/engine/player-name.ts TEXT_TOKEN): the id
 *  runs to the next closing brace. */
const TEXT_VARIABLE_TOKEN = /\{v:([^{}]*)\}/g;

/** The variable ids `{v:<id>}` tokens in `text` name, in order. */
export function textVariableIds(text: string): string[] {
  if (!text.includes("{v:")) return [];
  return [...text.matchAll(TEXT_VARIABLE_TOKEN)].map((m) => m[1]!);
}

/** `{x:<key>}` text tokens (src/engine/player-name.ts): the key runs to the
 *  next closing brace. */
const TEXT_X_TOKEN = /\{x:([^{}]*)\}/g;

/** The `{x:<key>}` token keys in `text`, de-duplicated in first-seen order. */
export function textTokenKeys(text: string): string[] {
  if (!text.includes("{x:")) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(TEXT_X_TOKEN)) {
    const key = m[1]!;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/** The player-visible strings of one command that the runtime expands
 *  tokens in: text lines, a choices prompt and its option rows, an
 *  extChoice prompt (its rows come from the extension at runtime). */
function commandTexts(command: Command): string[] {
  switch (command.op) {
    case "text":
      return command.lines;
    case "choices":
      return [command.prompt, ...command.options.map((option) => option.text)];
    case "extChoice":
      return [command.prompt];
    default:
      return [];
  }
}

function tileSheet(id: string): string | null {
  const dot = id.indexOf(".");
  return dot > 0 ? id.slice(0, dot) : null;
}

// ---- lint context ---------------------------------------------------------

/** Shared state for one lint pass. A full pass lints every map, then the
 *  common events, then the document-global checks. A scoped pass lints one
 *  map against the catalogs the context supplies, so its findings are
 *  identical to the full pass's findings for that map (the global checks —
 *  switch/variable pairing, reachability, start — run once per pass). */
export interface LintContext {
  findings: Finding[];
  sheetIds: Set<string>;
  itemIds: Set<string>;
  /** Null when the document declares no audio table (undeclared ids are
   *  not checked, matching the inline behaviour). */
  audioIds: Set<string> | null;
  spriteIds: Set<string>;
  mapIds: Set<string>;
  commonIds: Set<string>;
  textVariables: boolean;
  textTokenAllowlist: Set<string> | null;
  switches: Map<string, Usage>;
  variables: Map<string, Usage>;
  sceneIds: Map<string, FindingLocation>;
  /** Which common events each common event calls (from the project's common
   *  events, so it is identical for every pass over the same shell). */
  commonCalls: Map<string, Set<string>>;
  /** Which maps call each common event, transitively. lintMap contributes
   *  one map's calls; lintCommonEvents reads the merged result. */
  commonCallers: Map<string, Set<string>>;
  /** Literal transfer edges per map (common programs inlined), feeding the
   *  reachability check in lintGlobal. */
  edges: Map<string, Set<string>>;
  /** When set, lintMap records its full per-map usage here (incremental
   *  cache). Null on ordinary passes — zero overhead. */
  usageSink: UsageSink | null;
  pageCount: number;
  commandCount: number;
}

export function createLintContext(project: Project): LintContext {
  const commonCalls = new Map<string, Set<string>>();
  for (const common of project.commonEvents ?? []) {
    const calls = new Set<string>();
    walkCommands(common.commands, (command) => {
      if (command.op === "common") calls.add(command.id);
    });
    commonCalls.set(common.id, calls);
  }
  return {
    findings: [],
    sheetIds: new Set(project.sheets.map((s) => s.id)),
    itemIds: new Set(project.items.map((i) => i.id)),
    audioIds: project.audio === undefined ? null : new Set(Object.keys(project.audio)),
    spriteIds: new Set(project.sprites ? Object.keys(project.sprites) : []),
    mapIds: new Set(project.maps.map((m) => m.id)),
    commonIds: new Set((project.commonEvents ?? []).map((c) => c.id)),
    textVariables: project.system?.textVariables === true,
    textTokenAllowlist: project.system?.textTokens ? new Set(project.system.textTokens) : null,
    switches: new Map(),
    variables: new Map(),
    sceneIds: new Map(),
    commonCalls,
    commonCallers: new Map(),
    edges: new Map(),
    usageSink: null,
    pageCount: 0,
    commandCount: 0,
  };
}

function note(
  ctx: LintContext,
  kind: "switches" | "variables",
  id: string,
  op: "reads" | "writes",
  loc: FindingLocation,
): void {
  const usage = kind === "switches" ? ctx.switches : ctx.variables;
  const entry = usage.get(id) ?? { reads: [], writes: [] };
  entry[op].push(loc);
  usage.set(id, entry);
  const sink = kind === "switches" ? ctx.usageSink?.switches : ctx.usageSink?.variables;
  if (sink) {
    const own = sink.get(id) ?? { reads: [], writes: [] };
    own[op].push(loc);
    sink.set(id, own);
  }
}

function noteConditionReads(
  ctx: LintContext,
  condition: Condition,
  loc: FindingLocation,
  map: MapDef | null,
): void {
  if (condition.kind === "switch") {
    note(ctx, "switches", condition.id, "reads", loc);
  } else if (condition.kind === "variable") {
    note(ctx, "variables", condition.id, "reads", loc);
  } else if (condition.kind === "item") {
    if (!ctx.itemIds.has(condition.id)) missingItem(ctx, condition.id, loc);
  } else if (condition.kind === "bgmPlaying") {
    if (condition.id !== undefined) missingAudio(ctx, condition.id, loc);
  } else if (condition.kind === "appearance") {
    // The engine compares the target's ONE effective sprite key against this
    // value; an unknown key can never be the live sprite (null is the
    // built-in/none art and is always valid).
    if (typeof condition.sprite === "string" && !ctx.spriteIds.has(condition.sprite)) {
      ctx.findings.push(makeFinding(
        "lint/sprite-missing",
        "error",
        `condition compares against unknown sprite ${JSON.stringify(condition.sprite)}`,
        "add the sprite to project.sprites or fix the key",
        loc,
      ));
    }
    // An appearance condition whose target event has no live page evaluates
    // false (interpreter.ts evalCondition). "player" and "this" always
    // resolve; {event:"x"} resolves against the HOST map only, so an event
    // absent there makes the clause always false. The host map is unprovable
    // for a common event with zero/several callers (map === null) — skip.
    if (map && typeof condition.target === "object" && "event" in condition.target) {
      const targetId = condition.target.event;
      if (!map.events?.some((e) => e.id === targetId)) {
        ctx.findings.push(makeFinding(
          "lint/appearance-target-missing",
          "error",
          `condition targets unknown event ${JSON.stringify(targetId)} (the clause always evaluates false)`,
          "fix the event id or remove the clause; an appearance condition on a missing event never holds",
          loc,
        ));
      }
    }
  } else if (condition.kind === "tileProperty") {
    // Unlike the tileProperty COMMAND (which throws out of bounds), a
    // tileProperty CONDITION with out-of-bounds coordinates evaluates false
    // (interpreter.ts evalCondition) — the clause can never hold.
    if (map && (condition.x < 0 || condition.y < 0 || condition.x >= map.width || condition.y >= map.height)) {
      ctx.findings.push(makeFinding(
        "lint/tileproperty-out-of-bounds",
        "error",
        `tileProperty condition at (${condition.x}, ${condition.y}) is outside the map; the clause always evaluates false`,
        "move the cell inside the map or remove the clause",
        loc,
      ));
    }
  }
}

function notePageConditionReads(
  ctx: LintContext,
  condition: PageCondition | undefined,
  loc: FindingLocation,
  map: MapDef | null,
): void {
  for (const c of flattenPageCondition(condition)) {
    noteConditionReads(ctx, c, loc, map);
  }
}

function missingItem(ctx: LintContext, id: string, loc: FindingLocation): void {
  ctx.findings.push(makeFinding(
    "lint/item-missing",
    "error",
    `condition references unknown item ${JSON.stringify(id)}`,
    "add the item to the catalog or fix the id",
    loc,
  ));
}

function missingAudio(ctx: LintContext, id: string, loc: FindingLocation): void {
  if (ctx.audioIds === null || ctx.audioIds.has(id)) return;
  // The document only exposes the logical-id table, not whether a missing
  // entry is supplied by a partial/host audio setup or is an authored typo.
  // Keep the precise finding so the reference is reviewable, but do not
  // make that ambiguity fail lint.
  ctx.findings.push(makeFinding(
    "lint/audio-missing",
    "warning",
    `audio reference uses undeclared id ${JSON.stringify(id)}`,
    "add the logical id to project.audio or fix the reference",
    loc,
  ));
}

// Walk one command tree. `map` is the host map for place/moveRoute/
// appearance/tileProperty checks; null means a common event whose host map
// is unknown (zero or several callers — those checks are skipped; transfer
// map-id and catalog checks still apply).
function walkCommandTree(
  ctx: LintContext,
  project: Project,
  commands: readonly Command[],
  loc: FindingLocation,
  map: MapDef | null,
): void {
  // Labels are list-local: a jumpLabel resolves against the labels of the
  // page or common event that contains it, at any nesting depth. Collect
  // them in one pass, then warn on jumps to a name with no label.
  const labels = new Set<string>();
  const jumps: { name: string; loc: FindingLocation }[] = [];
  walkCommands(commands, (command, path) => {
    ctx.commandCount++;
    const cloc = { ...loc, commandPath: path };
    if (command.op === "label") {
      labels.add(command.name);
    } else if (command.op === "jumpLabel") {
      jumps.push({ name: command.name, loc: cloc });
    }
    // `{v:<id>}` tokens: with system.textVariables each is a live READ of
    // the variable; without it the braces print verbatim.
    const tokenIds = commandTexts(command).flatMap(textVariableIds);
    if (tokenIds.length > 0) {
      if (ctx.textVariables) {
        for (const id of tokenIds) note(ctx, "variables", id, "reads", cloc);
      } else {
        ctx.findings.push(makeFinding(
          "lint/text-variable-token-off",
          "warning",
          `${command.op} text holds ${tokenIds.map((id) => `{v:${id}}`).join(", ")} but system.textVariables is off, so the token prints verbatim`,
          "set project.system.textVariables to true to expand {v:<id>} to the variable's value, or remove the token",
          cloc,
        ));
      }
    }
    // `{x:<key>}` tokens: the resolver is code-side, so with a declared
    // system.textTokens allowlist each key must be listed; without a
    // declaration the token prints verbatim and the project likely forgot
    // the opt-in. One finding per unknown/off key per command (a key on
    // several lines counts once).
    const xKeys = new Set(commandTexts(command).flatMap(textTokenKeys));
    if (ctx.textTokenAllowlist) {
      for (const key of xKeys) {
        if (!ctx.textTokenAllowlist.has(key)) {
          ctx.findings.push(makeFinding(
            "lint/text-token-unknown",
            "warning",
            `${command.op} text holds {x:${key}} but project.system.textTokens does not list it`,
            "add the key to project.system.textTokens, or fix the token; an unanswered token shows ??? at runtime",
            cloc,
          ));
        }
      }
    } else if (xKeys.size > 0) {
      ctx.findings.push(makeFinding(
        "lint/text-token-off",
        "warning",
        `${command.op} text holds ${[...xKeys].map((key) => `{x:${key}}`).join(", ")} but project.system.textTokens is not declared, so the token prints verbatim`,
        "declare project.system.textTokens (the keys the session resolver answers) to expand {x:<key>}, or remove the token",
        cloc,
      ));
    }
    switch (command.op) {
      case "switch":
        note(ctx, "switches", command.id, "writes", cloc);
        break;
      case "variable":
        note(ctx, "variables", command.id, "writes", cloc);
        if ("from" in command.set) note(ctx, "variables", command.set.from, "reads", cloc);
        break;
      case "showPicture":
      case "movePicture":
        if (typeof command.x === "object") note(ctx, "variables", command.x.variable, "reads", cloc);
        if (typeof command.y === "object") note(ctx, "variables", command.y.variable, "reads", cloc);
        break;
      case "timer":
        if (command.action === "read") note(ctx, "variables", command.variable, "writes", cloc);
        break;
      case "inputNumber":
        // The scene prefills from the current value and replaces it on OK.
        note(ctx, "variables", command.variable, "reads", cloc);
        note(ctx, "variables", command.variable, "writes", cloc);
        break;
      case "selectItem":
        // The scene writes the chosen item's numeric id (0 on cancel).
        note(ctx, "variables", command.variable, "writes", cloc);
        break;
      case "locationInfo":
        // Writes the cell fact; variable coordinates are live reads.
        note(ctx, "variables", command.variable, "writes", cloc);
        if (typeof command.x === "object") note(ctx, "variables", command.x.variable, "reads", cloc);
        if (typeof command.y === "object") note(ctx, "variables", command.y.variable, "reads", cloc);
        break;
      case "selfSwitch":
        // Writes are collected per event with walkProjectCommands (common
        // event writes run on the caller's fiber), not here.
        break;
      case "if":
        noteConditionReads(ctx, command.if, cloc, map);
        break;
      case "playBgm":
      case "playBgs":
      case "playMe":
      case "playSe":
        missingAudio(ctx, command.id, cloc);
        break;
      case "transfer": {
        if (typeof command.map === "string") {
          const target = project.maps.find((m) => m.id === command.map);
          if (!target) {
            ctx.findings.push(makeFinding(
              "lint/transfer-target-missing",
              "error",
              `transfer targets unknown map ${JSON.stringify(command.map)}`,
              "add the map or fix the id; a transfer to a missing map throws at runtime",
              cloc,
            ));
          } else {
            // Each axis is checked independently: a literal x on a narrow
            // map is provably out of bounds even when y is dynamic.
            const oobX = typeof command.x === "number" && (command.x < 0 || command.x >= target.width);
            const oobY = typeof command.y === "number" && (command.y < 0 || command.y >= target.height);
            if (oobX || oobY) {
              const cx = typeof command.x === "number" ? command.x : "dynamic";
              const cy = typeof command.y === "number" ? command.y : "dynamic";
              ctx.findings.push(makeFinding(
                "lint/transfer-target-missing",
                "error",
                `transfer lands out of bounds at (${cx}, ${cy}) on ${target.width}x${target.height} map ${JSON.stringify(target.id)}`,
                "move the landing inside the map",
                cloc,
              ));
            }
          }
        } else {
          note(ctx, "variables", command.map.variable, "reads", cloc);
        }
        if (typeof command.x === "object") note(ctx, "variables", command.x.variable, "reads", cloc);
        if (typeof command.y === "object") note(ctx, "variables", command.y.variable, "reads", cloc);
        if (command.dir && typeof command.dir === "object") note(ctx, "variables", command.dir.variable, "reads", cloc);
        break;
      }
      case "place": {
        if (map) {
          if (typeof command.target === "object") {
            const targetId = command.target.event;
            if (!map.events?.some((e) => e.id === targetId)) {
              ctx.findings.push(makeFinding(
                "lint/place-target-missing",
                "error",
                `place targets unknown event ${JSON.stringify(targetId)} on map ${JSON.stringify(map.id)}`,
                "fix the event id; placing a missing event throws at runtime",
                cloc,
              ));
            }
          }
          if (command.x < 0 || command.y < 0 || command.x >= map.width || command.y >= map.height) {
            ctx.findings.push(makeFinding(
              "lint/place-target-missing",
              "error",
              `place lands out of bounds at (${command.x}, ${command.y}) on ${map.width}x${map.height} map ${JSON.stringify(map.id)}`,
              "move the placement inside the map",
              cloc,
            ));
          }
        }
        break;
      }
      case "moveRoute": {
        if (map && typeof command.target === "object" && command.target !== null && "event" in command.target) {
          const targetId = command.target.event;
          if (!map.events?.some((e) => e.id === targetId)) {
            ctx.findings.push(makeFinding(
              "lint/route-target-missing",
              "error",
              `moveRoute targets unknown event ${JSON.stringify(targetId)} on map ${JSON.stringify(map.id)}`,
              "fix the event id",
              cloc,
            ));
          }
        }
        break;
      }
      case "appearance": {
        if (typeof command.sprite === "string" && !ctx.spriteIds.has(command.sprite)) {
          ctx.findings.push(makeFinding(
            "lint/sprite-missing",
            "error",
            `appearance sets unknown sprite ${JSON.stringify(command.sprite)}`,
            "add the sprite to project.sprites or fix the key",
            cloc,
          ));
        }
        if (map && typeof command.target === "object" && "event" in command.target) {
          const targetId = command.target.event;
          if (!map.events?.some((e) => e.id === targetId)) {
            ctx.findings.push(makeFinding(
              "lint/appearance-target-missing",
              "error",
              `appearance targets unknown event ${JSON.stringify(targetId)} on map ${JSON.stringify(map.id)}`,
              "fix the event id; changing the appearance of a missing event throws at runtime",
              cloc,
            ));
          }
        }
        break;
      }
      case "tileProperty": {
        if (map && (command.x < 0 || command.y < 0 || command.x >= map.width || command.y >= map.height)) {
          ctx.findings.push(makeFinding(
            "lint/tileproperty-out-of-bounds",
            "error",
            `tileProperty targets cell (${command.x}, ${command.y}), outside the ${map.width}x${map.height} bounds of map ${JSON.stringify(map.id)}`,
            "the runtime throws a content error for an out-of-bounds tileProperty; move the cell inside the map",
            cloc,
          ));
        }
        break;
      }
      case "common":
        if (!ctx.commonIds.has(command.id)) {
          ctx.findings.push(makeFinding(
            "lint/common-event-missing",
            "error",
            `common calls unknown common event ${JSON.stringify(command.id)}`,
            "add the common event or fix the id",
            cloc,
          ));
        }
        break;
      case "item":
        if (!ctx.itemIds.has(command.item)) {
          ctx.findings.push(makeFinding(
            "lint/item-missing",
            "error",
            `item op references unknown item ${JSON.stringify(command.item)}`,
            "add the item to the catalog or fix the id",
            cloc,
          ));
        }
        break;
      case "shop":
        for (const good of command.goods) {
          if (!ctx.itemIds.has(good.item)) {
            ctx.findings.push(makeFinding(
              "lint/item-missing",
              "error",
              `shop ${JSON.stringify(command.id)} sells unknown item ${JSON.stringify(good.item)}`,
              "add the item to the catalog or fix the id",
              cloc,
            ));
          }
          notePageConditionReads(ctx, good.condition, cloc, map);
        }
        break;
      case "choices":
        // A row icon draws one frame of a project.sprites entry; an unknown
        // key has nothing to draw. The path points at the option's icon.
        command.options.forEach((option, optionIndex) => {
          if (option.icon && !ctx.spriteIds.has(option.icon.sprite)) {
            ctx.findings.push(makeFinding(
              "lint/sprite-missing",
              "error",
              `choices option ${optionIndex} icon uses unknown sprite ${JSON.stringify(option.icon.sprite)}`,
              "add the sprite to project.sprites or fix the key",
              { ...loc, commandPath: [...path, "options", optionIndex, "icon"] },
            ));
          }
        });
        if (command.options.length === 0 && !command.cancel) {
          ctx.findings.push(makeFinding(
            "lint/choices-empty",
            "error",
            "choices has no options and no cancel branch",
            "the modal can never be dismissed — add an option or a cancel branch",
            cloc,
          ));
        } else if (command.options.length > 0) {
          const cancelEmpty = !command.cancel || command.cancel.commands.length === 0;
          const emptyOptions = command.options
            .map((option, index) => (option.commands.length === 0 ? index : -1))
            .filter((index) => index >= 0);
          if (emptyOptions.length === command.options.length && cancelEmpty) {
            ctx.findings.push(makeFinding(
              "lint/choices-empty",
              "warning",
              "choices has options but every branch (and the cancel) is empty",
              "the choice is a no-op — give a branch commands or remove the choices",
              cloc,
            ));
          } else if (emptyOptions.length === command.options.length) {
            // Every selectable option is a dead end; only dismissing the
            // box (the cancel) does anything.
            ctx.findings.push(makeFinding(
              "lint/choices-empty",
              "warning",
              "choices has options but every option is empty; only the cancel branch has commands",
              "the selectable options are dead ends — give an option commands or remove it",
              cloc,
            ));
          } else if (emptyOptions.length > 0) {
            ctx.findings.push(makeFinding(
              "lint/choices-empty",
              "warning",
              `choices option(s) ${emptyOptions.join(", ")} have no commands`,
              "an empty option is a dead end — give it a command or remove it",
              cloc,
            ));
          }
        }
        break;
      case "extChoice":
        if (command.write?.index) note(ctx, "variables", command.write.index, "writes", cloc);
        if (command.write?.key) note(ctx, "variables", command.write.key, "writes", cloc);
        if (command.write?.cancelled) note(ctx, "variables", command.write.cancelled, "writes", cloc);
        break;
      case "scene":
        if (!ctx.sceneIds.has(command.id)) {
          ctx.sceneIds.set(command.id, cloc);
          ctx.usageSink?.scenes.set(command.id, cloc);
        }
        break;
      case "break":
        // A loop body is walked under the "commands" tag (walk.ts); the
        // tree here never inlines common events, so a break in a common
        // event called from a loop is correctly "outside" (a break does
        // not cross the call: it ends the common event).
        if (!path.includes("commands")) {
          ctx.findings.push(makeFinding(
            "lint/break-outside-loop",
            "info",
            "break is not inside any loop; it ends the current page or common event here",
            "legal (RPG Maker parity) — keep it as an early exit, or wrap the commands it should leave in a loop",
            cloc,
          ));
        }
        break;
      default:
        break;
    }
  });
  for (const jump of jumps) {
    if (!labels.has(jump.name)) {
      ctx.findings.push(makeFinding(
        "lint/jump-label-missing",
        "warning",
        `jumpLabel targets ${JSON.stringify(jump.name)}, but this page or common event has no label with that name`,
        "the jump does nothing (RPG Maker parity) — add a matching label or fix the name",
        jump.loc,
      ));
    }
  }
}

/** The common event ids a map calls directly (one `common` op per id, in
 *  page/command order). The transitive closure is the caller's job. Shared
 *  by lintMap and the incremental cache's usage digest. */
export function mapDirectCommonCalls(map: MapDef): string[] {
  const calls: string[] = [];
  const seen = new Set<string>();
  for (const event of map.events ?? []) {
    for (const page of event.pages) {
      walkCommands(page.commands, (command) => {
        if (command.op === "common" && !seen.has(command.id)) {
          seen.add(command.id);
          calls.push(command.id);
        }
      });
    }
  }
  return calls;
}

/** Lint one map: its sheet/tile references, every event page (conditions,
 *  command tree, self switches, dead pages), and its contribution to the
 *  common-event caller map and transfer edges. Findings are attributed to
 *  this map only and are identical whether the pass is full or scoped. */
export function lintMap(ctx: LintContext, project: Project, map: MapDef): void {
  // Which common events this map calls, transitively (a `common` op anywhere
  // in a map's event pages, including inside a common event that map calls).
  const direct = mapDirectCommonCalls(map);
  ctx.usageSink?.commonCalls.push(...direct);
  const reachable = new Set<string>(direct);
  const queue = [...reachable];
  while (queue.length > 0) {
    for (const called of ctx.commonCalls.get(queue.shift()!) ?? []) {
      if (!reachable.has(called)) {
        reachable.add(called);
        queue.push(called);
      }
    }
  }
  for (const id of reachable) {
    const callers = ctx.commonCallers.get(id) ?? new Set<string>();
    callers.add(map.id);
    ctx.commonCallers.set(id, callers);
  }

  for (const sheetId of map.sheets ?? []) {
    if (!ctx.sheetIds.has(sheetId)) {
      ctx.findings.push(makeFinding(
        "lint/sheet-missing",
        "error",
        `map ${JSON.stringify(map.id)} draws from unknown sheet ${JSON.stringify(sheetId)}`,
        "add the sheet or fix the id",
        { map: map.id },
      ));
    }
  }
  const checkTile = (tile: string | null, loc: FindingLocation): void => {
    if (!tile) return;
    const sheet = tileSheet(tile);
    if (sheet && !ctx.sheetIds.has(sheet)) {
      ctx.findings.push(makeFinding(
        "lint/sheet-missing",
        "error",
        `tile ${JSON.stringify(tile)} references unknown sheet ${JSON.stringify(sheet)}`,
        "add the sheet or fix the tile id",
        loc,
      ));
    }
  };
  map.ground.forEach((tile, index) => {
    checkTile(tile, { map: map.id, pointer: `/ground/${index}` });
  });
  for (const [index, tile] of map.upper ?? []) {
    checkTile(tile, { map: map.id, pointer: `/upper/${index}` });
  }

  for (const event of map.events ?? []) {
    // Only a page demanding self key K=TRUE can be dead: the runtime holds
    // one self key (or undefined), and a K=FALSE read is satisfied by the
    // default state, so it is never provably dead.
    const selfTrueReads = new Set<SelfKey>();
    const selfWrites = new Set<SelfKey>();
    const flatConditions: Condition[][] = [];

    event.pages.forEach((page, pageIndex) => {
      ctx.pageCount++;
      const loc: FindingLocation = { map: map.id, event: event.id, page: pageIndex };
      const flat = flattenPageCondition(page.condition);
      flatConditions.push(flat);
      for (const c of flat) {
        noteConditionReads(ctx, c, loc, map);
        if (c.kind === "selfSwitch" && (c.value ?? true) === true) selfTrueReads.add(c.key);
      }
      if (page.sprite !== undefined && page.sprite !== null && !ctx.spriteIds.has(page.sprite)) {
        ctx.findings.push(makeFinding(
          "lint/sprite-missing",
          "error",
          `page ${pageIndex} of event ${JSON.stringify(event.id)} uses unknown sprite ${JSON.stringify(page.sprite)}`,
          "add the sprite to project.sprites or fix the key",
          loc,
        ));
      }
      if (conditionContradiction(flat)) {
        ctx.findings.push(makeFinding(
          "lint/page-condition-contradiction",
          "error",
          `page ${pageIndex} of event ${JSON.stringify(event.id)} has a condition that can never hold`,
          "the page never activates; fix the contradictory clauses",
          loc,
        ));
      }
      walkCommandTree(ctx, project, page.commands, loc, map);
      // selfSwitch writes run on this event's fiber — including writes
      // inside common events this page calls (the interpreter executes the
      // common program on the caller's fiber). A value:false op only
      // CLEARS the key, so it cannot make a K=true page reachable.
      walkProjectCommands(project, page.commands, (command) => {
        if (command.op === "selfSwitch" && command.value !== false) selfWrites.add(command.key);
      });
    });

    for (const key of selfTrueReads) {
      if (!selfWrites.has(key)) {
        ctx.findings.push(makeFinding(
          "lint/selfswitch-read-never-set",
          "warning",
          `no page of event ${JSON.stringify(event.id)} (including common events it calls) ever sets self switch ${key}; pages requiring ${key}=true can never activate`,
          "add a selfSwitch set for it or drop the page condition",
          { map: map.id, event: event.id },
        ));
      }
    }

    // Dead pages: an earlier page whose condition implies a later page's
    // condition never wins selection (the later page wins whenever both
    // hold).
    for (let i = 0; i < flatConditions.length; i++) {
      for (let j = i + 1; j < flatConditions.length; j++) {
        if (conditionImplies(flatConditions[i]!, flatConditions[j]!)) {
          ctx.findings.push(makeFinding(
            "lint/page-shadowed",
            "error",
            `page ${i} of event ${JSON.stringify(event.id)} is shadowed by page ${j}: whenever page ${i}'s condition holds, page ${j}'s holds too and wins`,
            "delete the dead page or strengthen its condition",
            { map: map.id, event: event.id, page: i },
          ));
          break;
        }
      }
    }
  }

  // Literal transfer edges (common programs inlined) for the reachability
  // check in lintGlobal.
  const targets = new Set<string>();
  for (const event of map.events ?? []) {
    for (const page of event.pages) {
      walkProjectCommands(project, page.commands, (command) => {
        if (command.op === "transfer" && typeof command.map === "string") targets.add(command.map);
      });
    }
  }
  ctx.edges.set(map.id, targets);
  if (ctx.usageSink) for (const target of targets) ctx.usageSink.edges.add(target);
}

/** Lint the project's common events. A common event called from exactly one
 *  map is checked against that map's events/bounds; `resolveHostMap`
 *  supplies the caller map (a scoped/incremental pass may only have its
 *  stub). With zero or several callers the host map is unprovable and
 *  host-dependent checks skip. */
export function lintCommonEvents(
  ctx: LintContext,
  project: Project,
  resolveHostMap?: (callerId: string) => MapDef | null,
): void {
  for (const common of project.commonEvents ?? []) {
    const loc: FindingLocation = { common: common.id };
    if (common.conditionSwitch !== undefined) note(ctx, "switches", common.conditionSwitch, "reads", loc);
    const callers = ctx.commonCallers.get(common.id);
    const callerId = callers && callers.size === 1 ? [...callers][0]! : undefined;
    const hostMap = callerId === undefined
      ? null
      : resolveHostMap
        ? resolveHostMap(callerId)
        : (project.maps.find((m) => m.id === callerId) ?? null);
    walkCommandTree(ctx, project, common.commands, loc, hostMap);
  }
}

/** Document-global checks: scene id review, switch/variable read/write
 *  pairing, item sprite sheets, the start map, and static reachability.
 *  Everything here is a pure function of the merged context plus the
 *  project's catalogs and start. */
export function lintGlobal(ctx: LintContext, project: Project): void {
  // ---- scene ids ----------------------------------------------------------
  //
  // Scene rules are code-side (SessionOptions.scenes); the document cannot
  // register them. List each used id once so a reviewer can verify the
  // registration — an unregistered id makes createSession throw at startup.
  for (const [id, loc] of ctx.sceneIds) {
    ctx.findings.push(makeFinding(
      "lint/scene-id",
      "info",
      `scene id ${JSON.stringify(id)} is used by the document but has no registration in it`,
      "register SceneRules for it in code (the kit ships nameInputRules for \"rpgkit.nameInput\") or fix the id; an unregistered scene id throws at session startup",
      loc,
    ));
  }

  // ---- usage findings -----------------------------------------------------

  const usageFindings = (
    usage: Map<string, Usage>,
    readCheck: string,
    writeCheck: string,
    readSeverity: "warning" | "info",
    label: string,
  ): void => {
    for (const [id, entry] of usage) {
      if (entry.reads.length > 0 && entry.writes.length === 0) {
        ctx.findings.push(makeFinding(
          readCheck,
          readSeverity,
          `${label} ${JSON.stringify(id)} is read but never set anywhere in the document`,
          "it always evaluates to its default; if a save or an extension seeds it, ignore this finding",
          entry.reads[0]!,
        ));
      } else if (entry.writes.length > 0 && entry.reads.length === 0) {
        ctx.findings.push(makeFinding(
          writeCheck,
          "info",
          `${label} ${JSON.stringify(id)} is set but never read within the project document`,
          "dead write within the document; external code (tests, saves, extensions) may still read it — remove it or wire up a reader",
          entry.writes[0]!,
        ));
      }
    }
  };
  usageFindings(ctx.switches, "lint/switch-read-never-set", "lint/switch-set-never-read", "warning", "switch");
  usageFindings(ctx.variables, "lint/variable-read-never-set", "lint/variable-set-never-read", "info", "variable");

  // ---- item sprites reference tile sheets ---------------------------------

  for (const item of project.items) {
    const sheet = tileSheet(item.sprite);
    if (sheet && !ctx.sheetIds.has(sheet)) {
      ctx.findings.push(makeFinding(
        "lint/sheet-missing",
        "error",
        `item ${JSON.stringify(item.id)} sprite ${JSON.stringify(item.sprite)} references unknown sheet ${JSON.stringify(sheet)}`,
        "add the sheet or fix the sprite cell",
        { pointer: "/items" },
      ));
    }
  }

  // ---- start --------------------------------------------------------------

  const startMap = project.maps.find((m) => m.id === project.start.map);
  if (!startMap) {
    ctx.findings.push(makeFinding(
      "lint/start-map-missing",
      "error",
      `start map ${JSON.stringify(project.start.map)} is not in the document`,
      "fix start.map",
      { pointer: "/start" },
    ));
  } else if (
    project.start.x < 0 || project.start.y < 0 ||
    project.start.x >= startMap.width || project.start.y >= startMap.height
  ) {
    ctx.findings.push(makeFinding(
      "lint/start-map-missing",
      "error",
      `start position (${project.start.x}, ${project.start.y}) is out of bounds on ${startMap.width}x${startMap.height} map ${JSON.stringify(startMap.id)}`,
      "move the start inside the map",
      { pointer: "/start" },
    ));
  }

  // ---- static map reachability -------------------------------------------
  //
  // A literal transfer inside a common event runs on the caller's fiber, so
  // the edge is attributed to every caller map (walkProjectCommands inlines
  // the common program). BFS from the start map: a self-loop does not make
  // an isolated map reachable, and a chain of transfers only reaches maps
  // the chain can actually start from.

  const reachable = new Set<string>();
  if (ctx.mapIds.has(project.start.map)) {
    const queue: string[] = [project.start.map];
    reachable.add(project.start.map);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const target of ctx.edges.get(current) ?? []) {
        if (!reachable.has(target)) {
          reachable.add(target);
          queue.push(target);
        }
      }
    }
  }

  for (const map of project.maps) {
    if (!reachable.has(map.id)) {
      ctx.findings.push(makeFinding(
        "lint/map-unreachable",
        "warning",
        `map ${JSON.stringify(map.id)} is not reachable from start map ${JSON.stringify(project.start.map)} by any sequence of literal-id transfers`,
        "dynamic transfers (variable operands) can still reach it; add a transfer path or remove the map",
        { map: map.id },
      ));
    }
  }
}

/** Full static health check. Findings keep their historical order: document
 *  problems first, then per-map findings in map order, then common events,
 *  then the document-global checks. */
export function lintProject(project: Project, schemaErrors: readonly Finding[] = []): CheckReport {
  const ctx = createLintContext(project);
  ctx.findings.push(...schemaErrors, ...structuralFindings(project));

  for (const map of project.maps) lintMap(ctx, project, map);
  lintCommonEvents(ctx, project);
  lintGlobal(ctx, project);

  const bySeverity = ctx.findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});

  return {
    check: "lint",
    findings: ctx.findings,
    summary: {
      maps: project.maps.length,
      events: project.maps.reduce((n, m) => n + (m.events?.length ?? 0), 0),
      pages: ctx.pageCount,
      commands: ctx.commandCount,
      ...bySeverity,
    },
  };
}

/** Scoped static check of one map. Only that map's content is linted; the
 *  document-global checks (switch/variable pairing, scene review, start,
 *  reachability) need the whole document and are intentionally skipped —
 *  run the full pass for them. Catalog lookups still see every map id via
 *  the stubs the loader supplies. */
export function lintScoped(
  project: Project,
  mapId: string,
  schemaErrors: readonly Finding[] = [],
): CheckReport {
  const ctx = createLintContext(project);
  ctx.findings.push(...schemaErrors, ...structuralFindings(project));
  const map = project.maps.find((m) => m.id === mapId);
  if (!map) throw new Error(`lintScoped: map ${JSON.stringify(mapId)} not found`);
  lintMap(ctx, project, map);
  const bySeverity = ctx.findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  return {
    check: "lint",
    findings: ctx.findings,
    summary: {
      maps: 1,
      scopedMap: mapId,
      events: map.events?.length ?? 0,
      pages: ctx.pageCount,
      commands: ctx.commandCount,
      ...bySeverity,
    },
  };
}
