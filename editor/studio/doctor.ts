// editor/studio/doctor.ts — health checks that come with a one-click fix.
// Each finding carries the editor/api operations that repair it, so the
// Problems panel can offer a Fix button whose change is one undoable
// transaction. Pure (no DOM, no store): a Project goes in, findings come out.
//
// The detectors here are the fixable subset of project health. rpgkit-check's
// lint (tools/rpgkit-check) covers more checks without fixes; the two
// complement each other. Only map events are checked: the edit operations the
// fixes run through address map/event/page, not common events.
//
// The autorun check is empirical, not syntactic: a static scan cannot prove a
// page "never deactivates" (it cannot track values, reachability or common
// events), so the doctor runs the real engine on a copy of the map from a
// fresh entry with no input, counts each autorun page's fiber starts, and
// flags a page only when it restarted on every frame from its first start.
// The finding states only what was measured (the probe window and the start
// frames) and describes the standard one-shot pattern; it does not claim the
// page can never deactivate, and it carries no automatic rewrite — a fix
// cannot be proven safe from a finite window, so the repair is left to the
// author.

import type { Command, GameEvent, MapDef, Page, Project } from "../../src/engine/types.ts";
import type { Instr } from "../../src/engine/interpreter.ts";
import type { SessionOperation } from "../api/session.ts";
import { flattenCommands, ROOT_COMMAND_PATH, type CommandAddress } from "../engine/commands.ts";
import { classifyCommand, type RuntimeChannel } from "../engine/event-explain.ts";
import { createSession, startSession, stepSession } from "../../src/engine/session.ts";
import { PLAYTEST_BATTLE_RULES, PLAYTEST_SCENE_RULES } from "../engine/playtest-view.ts";
import { playtestSceneIds } from "../engine/playtest.ts";
import { NUMBER_INPUT_SCENE_ID } from "../../src/engine/number-input.ts";
import { SELECT_ITEM_SCENE_ID } from "../../src/engine/select-item.ts";
import { NAME_INPUT_SCENE_ID } from "../../src/engine/name-input.ts";
import type { ExtensionChoiceHandler } from "../../src/engine/extensions.ts";
import type { SceneRules } from "../../src/engine/scene.ts";

export interface DoctorFix {
  /** Short label for the Fix button, e.g. "Insert label 'done'". */
  label: string;
  /** One sentence on what the fix does (the button's tooltip / preview). */
  description: string;
  /** The operations to run in one transaction. */
  ops: SessionOperation[];
}

export interface DoctorFinding {
  /** Stable check id, e.g. "doctor/label-missing". */
  check: string;
  severity: "error" | "warning" | "info";
  message: string;
  loc: { map?: string; event?: string; page?: number };
  /** Present when the finding can be repaired with one undoable
   *  transaction. A finding without a fix is reported for manual review. */
  fix?: DoctorFix;
}

interface Ctx {
  mapIds: Set<string>;
  commonById: Map<string, { commands: readonly Command[] }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Every command in a page's tree with its address, branches included. */
function pageCommands(page: Page): { command: Command; address: CommandAddress }[] {
  return flattenCommands(page.commands).map((row) => ({ command: row.command, address: row.address }));
}

/** The child command lists of a branching command (if/choices/battle/scene/
 *  loop), in authored order. */
function branchLists(command: Command): Command[][] {
  const value = command as Command & Record<string, unknown>;
  const lists: Command[][] = [];
  if (value.op === "if") {
    if (Array.isArray(value.then)) lists.push(value.then as Command[]);
    if (Array.isArray(value.else)) lists.push(value.else as Command[]);
  } else if (value.op === "choices" && Array.isArray(value.options)) {
    for (const option of value.options) {
      if (isRecord(option) && Array.isArray(option.commands)) lists.push(option.commands as Command[]);
    }
    if (isRecord(value.cancel) && Array.isArray(value.cancel.commands)) lists.push(value.cancel.commands as Command[]);
  } else if (value.op === "battle") {
    for (const prop of ["onWin", "onLose", "onEscape"] as const) {
      if (Array.isArray(value[prop])) lists.push(value[prop] as Command[]);
    }
  } else if (value.op === "scene") {
    for (const prop of ["onDone", "onCancel"] as const) {
      if (Array.isArray(value[prop])) lists.push(value[prop] as Command[]);
    }
  } else if (value.op === "loop" && Array.isArray(value.commands)) {
    lists.push(value.commands as Command[]);
  }
  return lists;
}

/** The self-switch keys an event sets ON, following `common` calls into the
 *  common events they invoke (bounded, cycle-safe). A page whose condition
 *  needs a self switch nobody sets can never win. */
function eventSelfSwitchWrites(event: GameEvent, commonById: Ctx["commonById"]): Set<string> {
  const set = new Set<string>();
  const seen = new Set<string>();
  const walk = (commands: readonly Command[]): void => {
    for (const command of commands) {
      const value = command as Command & Record<string, unknown>;
      if (value.op === "selfSwitch" && value.value === true && typeof value.key === "string") {
        set.add(value.key);
      } else if (value.op === "common" && typeof value.id === "string" && !seen.has(value.id)) {
        seen.add(value.id);
        const common = commonById.get(value.id);
        if (common) walk(common.commands);
      }
      for (const branch of branchLists(command)) walk(branch);
    }
  };
  for (const page of event.pages) walk(page.commands);
  return set;
}

/** How many no-input frames the autorun probe runs. Long enough that a page
 *  which restarts every frame does so many times (the evidence), short enough
 *  to stay cheap. A page that yields (wait/text/choice/scene/battle) or
 *  deactivates within this window does not restart on every frame. */
const PROBE_FRAMES = 12;

/** A choice waits for player input. The probe registers this handler for
 *  every extension choice the document uses, so an `extChoice` opens its
 *  modal and parks (like the built-in choices) instead of being skipped by
 *  the allowUnknown preview fallback. With no input the modal stays open, so
 *  a one-shot page that writes its condition variable through extChoice.write
 *  is not mistaken for an every-frame restarter. */
const PARKING_CHOICE_HANDLER: ExtensionChoiceHandler = {
  options: () => [
    { key: "ok", label: "OK" },
    { key: "cancel", label: "Cancel" },
  ],
};

/** Every extension-choice call id the document uses (map events, common
 *  events, nested branches), each mapped to the parking handler. */
function parkingChoices(project: Project): Record<string, ExtensionChoiceHandler> {
  const calls = new Set<string>();
  const walk = (commands: readonly Command[]): void => {
    for (const command of commands) {
      const value = command as Command & Record<string, unknown>;
      if (value.op === "extChoice" && typeof value.call === "string" && value.call) calls.add(value.call);
      for (const branch of branchLists(command)) walk(branch);
    }
  };
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) walk(page.commands);
    }
  }
  for (const common of project.commonEvents ?? []) walk(common.commands);
  return Object.fromEntries([...calls].map((call) => [call, PARKING_CHOICE_HANDLER]));
}

/** Placeholder scene rules for every scene id the document references
 *  (authored `scene` commands plus the engine's built-in inputNumber/
 *  selectItem/nameInput), so the probe session previews scenes instead of
 *  throwing the engine's unregistered-scene startup error. With no input the
 *  placeholder never completes, so a scene parks its fiber (the faithful
 *  no-input behavior) rather than looping. */
function probeSceneRules(project: Project): Record<string, SceneRules> {
  const ids = new Set<string>([NUMBER_INPUT_SCENE_ID, SELECT_ITEM_SCENE_ID, NAME_INPUT_SCENE_ID]);
  for (const id of playtestSceneIds(project)) ids.add(id);
  return Object.fromEntries([...ids].map((id) => [id, PLAYTEST_SCENE_RULES]));
}

/** Where the probe session starts on the map: the first autorun event's
 *  cell. Autorun pages run regardless of the player's position, and spawning
 *  on the event under test avoids tripping a different event's playerTouch
 *  page on entry. */
function probeCell(map: MapDef, firstAutorun: GameEvent): { x: number; y: number } {
  return { x: firstAutorun.x, y: firstAutorun.y };
}

/** The runtime channel an executed instruction flows through, or null for
 *  instructions that are not runtime-decided writers. Mirrors
 *  classifyCommand's runtime cases, but on the executed instruction — so a
 *  transfer in a branch the probe never took is not counted. */
function instructionChannel(ins: Instr): RuntimeChannel | null {
  switch (ins.op) {
    case "ext":
      return "extension command";
    case "extChoice":
      return "extension choice";
    case "battle":
      return "battle";
    case "scene":
      return "scene";
    case "shop":
      return "shop";
    case "transfer":
      // A literal map is a static destination; only a variable reference
      // is a runtime-decided channel.
      return typeof ins.map !== "string" ? "variable-target transfer" : null;
    default:
      return null;
  }
}

/** A short, human-readable name for an instruction the probe could not
 *  simulate, naming the runtime operand (a transfer's map variable, an
 *  extension's call id) so the author can find the command on the page. */
function describeInstruction(ins: Instr): string {
  switch (ins.op) {
    case "ext":
      return `an extension command (${ins.call})`;
    case "extChoice":
      return `an extension choice (${ins.call})`;
    case "battle":
      return "a battle";
    case "scene":
      return `a scene (${ins.id})`;
    case "shop":
      return `a shop (${ins.id})`;
    case "transfer":
      return typeof ins.map !== "string"
        ? `a variable-target transfer (map from variable ${JSON.stringify(ins.map.variable)})`
        : `a transfer to ${ins.map}`;
    default:
      return `a ${ins.op} command`;
  }
}

/** What the autorun probe observed: per-page fiber starts, the runtime
 *  channels each page's fiber actually executed (so the caveat names only
 *  those), and the content error that stopped the probe, if any (a command
 *  the probe cannot simulate — an unknown extension run as a no-op, so a
 *  variable a real handler would set stays unset). */
interface ProbeResult {
  starts: Map<string, number[]>;
  channels: Map<string, Set<RuntimeChannel>>;
  error: { eventId: string; pageIndex: number; message: string; ins: Instr | null } | null;
}

/** Run the map from a fresh entry for PROBE_FRAMES with no input and record,
 *  per event page, the frames on which a blocking (non-parallel) fiber
 *  started and the runtime channels its fiber actually executed. The
 *  session uses the editor playtest's fallbacks (unknown extensions no-op,
 *  battles/scenes park) made total for the headless probe.
 *  Total: if the session cannot be built or run, the partial (possibly
 *  empty) result is returned with the error, so the caller can report the
 *  check as incomplete instead of silently producing no finding. */
function probeMap(
  project: Project,
  mapId: string,
  cell: { x: number; y: number },
): ProbeResult {
  const starts = new Map<string, number[]>();
  const channels = new Map<string, Set<RuntimeChannel>>();
  // Held in an object so the onInstruction closure can assign it without
  // TypeScript narrowing the read site to the initial null.
  const lastInstruction: { current: { key: string; pageIndex: number; ins: Instr } | null } = { current: null };
  let error: ProbeResult["error"] = null;
  try {
    const probeProject: Project = { ...project, start: { map: mapId, x: cell.x, y: cell.y, dir: "down" } };
    let frame = 0;
    const session = createSession(probeProject, 60, {
      extensions: { allowUnknown: true, choices: parkingChoices(project) },
      battle: PLAYTEST_BATTLE_RULES,
      scenes: probeSceneRules(project),
      onFiberStart: (key, pageIndex, parallel) => {
        if (parallel) return;
        const eventId = key.slice(key.lastIndexOf("/") + 1);
        const k = `${eventId}#${pageIndex}`;
        const list = starts.get(k);
        if (list) list.push(frame);
        else starts.set(k, [frame]);
      },
      onInstruction: (key, pageIndex, ins) => {
        const channel = instructionChannel(ins);
        if (channel) {
          const eventId = key.slice(key.lastIndexOf("/") + 1);
          const k = `${eventId}#${pageIndex}`;
          const set = channels.get(k);
          if (set) set.add(channel);
          else channels.set(k, new Set([channel]));
        }
        lastInstruction.current = { key, pageIndex, ins };
      },
    });
    let state = startSession(probeProject, session);
    for (frame = 0; frame < PROBE_FRAMES; frame++) {
      state = stepSession(session, state, { buttons: 0, confirmEdge: false });
      // A content error freezes the interpreter: the probe cannot continue,
      // so stop and report the check as incomplete for the page that errored.
      if (state.interp.error) break;
    }
    if (state.interp.error) {
      error = {
        eventId: lastInstruction.current ? lastInstruction.current.key.slice(lastInstruction.current.key.lastIndexOf("/") + 1) : "",
        pageIndex: lastInstruction.current?.pageIndex ?? 0,
        message: state.interp.error.message,
        ins: lastInstruction.current?.ins ?? null,
      };
    }
  } catch (thrown) {
    // A project the probe cannot build or run (a registration the fallbacks
    // do not cover, a malformed map) yields no evidence; report the check as
    // incomplete rather than silently producing no finding.
    error = {
      eventId: "",
      pageIndex: 0,
      message: thrown instanceof Error ? thrown.message : String(thrown),
      ins: null,
    };
  }
  return { starts, channels, error };
}

/** Whether a page restarted on every frame from its first start to the end
 *  of the probe window. `frames` is the sorted list of frames the page's
 *  fiber started. The finding reports this observed pattern; it does not
 *  claim the page can never deactivate outside the window. */
function restartsEveryFrame(frames: readonly number[]): boolean {
  if (frames.length < 2) return false;
  const first = frames[0]!;
  return frames.length === PROBE_FRAMES - first;
}

/** What the probe actually does with each runtime-decided channel. Only
 *  unknown extensions run as no-ops; an extension choice opens its modal
 *  and parks (the probe registers a parking handler), battles and scenes
 *  stay unfinished without input, a shop opens its modal and parks the
 *  fiber, and a variable-target transfer is followed to whatever map the
 *  variable names at that moment. Exhaustive over RuntimeChannel: a newly
 *  classified channel fails the Record check until its probe behavior is
 *  described here. */
const PROBE_FALLBACK: Record<RuntimeChannel, string> = {
  "extension command": "it runs extension commands as no-ops",
  "extension choice": "it parks extension choices on their open modal, since no input arrives",
  battle: "it parks battles, which never finish without input",
  scene: "it parks scenes, which never finish without input",
  shop: "it parks shops on their open modal, since no input arrives",
  "variable-target transfer": "it follows variable-target transfers to whatever map the variable names at that moment",
};

/** The runtime-decided write channels a page's command tree can flow
 *  through — its own commands (branches included) and those of the common
 *  events it calls (bounded, cycle-safe). Driven by classifyCommand, so a
 *  newly classified channel is reported here without a hand-written list. */
function pageRuntimeChannels(page: Page, commonById: Ctx["commonById"]): RuntimeChannel[] {
  const channels = new Set<RuntimeChannel>();
  const seen = new Set<string>();
  const walk = (commands: readonly Command[]): void => {
    for (const command of commands) {
      const value = command as Command & Record<string, unknown>;
      const cls = classifyCommand(command);
      if (cls.kind === "runtime") channels.add(cls.channel);
      if (value.op === "common" && typeof value.id === "string" && !seen.has(value.id)) {
        seen.add(value.id);
        const common = commonById.get(value.id);
        if (common) walk(common.commands);
      }
      for (const branch of branchLists(command)) walk(branch);
    }
  };
  walk(page.commands);
  return [...channels].sort();
}

/** The label names defined anywhere in a command tree (branches included). */
function definedLabels(commands: readonly Command[]): Set<string> {
  const labels = new Set<string>();
  const walk = (list: readonly Command[]): void => {
    for (const command of list) {
      const value = command as Command & Record<string, unknown>;
      if (value.op === "label" && typeof value.name === "string" && value.name) labels.add(value.name);
      for (const branch of branchLists(command)) walk(branch);
    }
  };
  walk(commands);
  return labels;
}

/** The insert address for "end of the page's root list". */
function endOfPageAddress(page: Page): CommandAddress {
  return { path: ROOT_COMMAND_PATH, index: page.commands.length };
}

function checkPageCommands(
  map: MapDef,
  event: GameEvent,
  page: Page,
  pageIndex: number,
  ctx: Ctx,
  findings: DoctorFinding[],
): void {
  const ref = { map: map.id, event: event.id, page: pageIndex };
  const rows = pageCommands(page);
  const labels = definedLabels(page.commands);

  for (const { command, address } of rows) {
    const value = command as Command & Record<string, unknown>;
    switch (value.op) {
      case "jumpLabel": {
        const name = text(value.name);
        if (name && !labels.has(name)) {
          findings.push({
            check: "doctor/label-missing",
            severity: "error",
            message: `Jump to label ${JSON.stringify(name)}, which is not defined on this page`,
            loc: ref,
            fix: {
              label: `Insert label ${JSON.stringify(name)}`,
              description: `Adds a "${name}" label at the end of the page so the jump lands there.`,
              ops: [{
                command: "insert-command",
                args: { ...ref, address: endOfPageAddress(page), command: { op: "label", name } },
              }],
            },
          });
        }
        break;
      }
      case "transfer": {
        const target = value.map;
        if (typeof target === "string" && target && !ctx.mapIds.has(target)) {
          findings.push({
            check: "doctor/transfer-target-missing",
            severity: "error",
            message: `Transfer to map ${JSON.stringify(target)}, which is not in the project`,
            loc: ref,
            fix: {
              label: "Delete the transfer",
              description: "Removes the transfer so the page no longer points at a missing map.",
              ops: [{ command: "delete-command", args: { ...ref, address } }],
            },
          });
        }
        break;
      }
      case "common": {
        const id = text(value.id);
        if (id && !ctx.commonById.has(id)) {
          findings.push({
            check: "doctor/common-event-missing",
            severity: "error",
            message: `Call common event ${JSON.stringify(id)}, which is not defined`,
            loc: ref,
            fix: {
              label: "Delete the call",
              description: "Removes the call to the undefined common event.",
              ops: [{ command: "delete-command", args: { ...ref, address } }],
            },
          });
        }
        break;
      }
      case "choices": {
        // A choices with fewer than 2 options is a schema violation, so the
        // edit operations (which validate the document first) refuse to
        // repair it. The schema error already points at it; the doctor does
        // not duplicate that.
        break;
      }
      default:
        break;
    }
  }
}

/** The finding for a page whose autorun check the probe could not complete:
 *  a command the probe cannot simulate (an unknown extension run as a
 *  no-op, so a variable a real handler would set stays unset) stopped the
 *  probe. Severity info, no fix — the probe is an approximation, and only
 *  the author knows the handler's real behavior. */
function incompleteFinding(
  map: MapDef,
  target: { event: GameEvent; pageIndex: number },
  error: { message: string; ins: Instr | null },
): DoctorFinding {
  const command = error.ins ? describeInstruction(error.ins) : "a command";
  return {
    check: "doctor/autorun-probe-incomplete",
    severity: "info",
    message: `Autorun check incomplete for this page: the probe stopped at ${command} (${error.message}). The probe runs your game with no input and unknown extensions as no-ops, so it may not reach the states your game's handlers produce — review this page manually.`,
    loc: { map: map.id, event: target.event.id, page: target.pageIndex },
  };
}

/** The empirical autorun check. A static scan cannot prove a page "never
 *  deactivates" (it cannot track values, reachability or common events), so
 *  the doctor runs the real engine on the map from a fresh entry with no
 *  input and counts each autorun page's fiber starts. A page that restarted
 *  on every frame from its first start is flagged with the measured frames
 *  as evidence. The finding states only what was observed in the probe
 *  window — it does not claim the page can never deactivate — and describes
 *  the standard one-shot pattern without applying it: a finite window cannot
 *  prove an automatic rewrite safe, so the repair is left to the author.
 *
 *  The fallback caveat names only the runtime channels the probe actually
 *  executed on this page's fiber (recorded by the instruction trace), not
 *  every channel the page statically contains — a channel in a branch the
 *  probe never took is not something the probe did, so the finding does not
 *  claim it did. If the probe stopped on a command it cannot simulate (an
 *  unknown extension run as a no-op, so a variable a real handler would set
 *  stays unset and a later variable-target transfer fails), the check is
 *  reported as incomplete for that page instead of silently producing no
 *  finding. */
function checkAutoruns(map: MapDef, project: Project, ctx: Ctx, findings: DoctorFinding[]): void {
  const targets: { event: GameEvent; page: Page; pageIndex: number }[] = [];
  for (const event of map.events ?? []) {
    event.pages.forEach((page, pageIndex) => {
      if (page.trigger === "autorun" && page.commands.length > 0) targets.push({ event, page, pageIndex });
    });
  }
  if (targets.length === 0) return;
  const probe = probeMap(project, map.id, probeCell(map, targets[0]!.event));
  // The probe stopped on a command it could not simulate. The page that was
  // executing gets an incomplete-check finding; if the failing page cannot
  // be attributed to a target, every target's check is incomplete (the probe
  // aborted before any of them had a full window). An aborted probe cannot
  // prove an every-frame restart, so no autorun finding is produced.
  if (probe.error) {
    const attributed = targets.find(
      (t) => t.event.id === probe.error!.eventId && t.pageIndex === probe.error!.pageIndex,
    );
    if (attributed) {
      findings.push(incompleteFinding(map, attributed, probe.error));
    } else {
      for (const t of targets) findings.push(incompleteFinding(map, t, probe.error));
    }
    return;
  }
  for (const { event, page, pageIndex } of targets) {
    const frames = probe.starts.get(`${event.id}#${pageIndex}`) ?? [];
    if (!restartsEveryFrame(frames)) continue;
    const staticChannels = pageRuntimeChannels(page, ctx.commonById);
    const executed = probe.channels.get(`${event.id}#${pageIndex}`);
    const caveatChannels = staticChannels.filter((channel) => executed?.has(channel));
    const caveat = caveatChannels.length
      ? ` The probe may not match your game: ${caveatChannels.map((channel) => PROBE_FALLBACK[channel]).join("; ")}.`
      : "";
    const first = frames[0]!;
    const last = frames[frames.length - 1]!;
    findings.push({
      check: "doctor/autorun-restarts-every-frame",
      severity: "warning",
      message: `Autorun restarted on every frame from frame ${first} (its first start) through frame ${last} of a ${PROBE_FRAMES}-frame probe from a fresh entry with no input (fiber starts on frames ${frames.join(", ")}). If it should run once, make it one-shot: set a self switch at the top of the page (or before each exit) and add an empty page conditioned on that switch, or erase the event.${caveat}`,
      loc: { map: map.id, event: event.id, page: pageIndex },
    });
  }
}

/** A page whose condition needs a self switch nobody sets can never win. */
function checkDeadPages(map: MapDef, event: GameEvent, ctx: Ctx, findings: DoctorFinding[]): void {
  const written = eventSelfSwitchWrites(event, ctx.commonById);
  event.pages.forEach((page, pageIndex) => {
    const condition = page.condition;
    if (!condition || typeof condition.selfSwitch !== "string") return;
    const key = condition.selfSwitch;
    if (written.has(key)) return;
    const loc = { map: map.id, event: event.id, page: pageIndex };
    if (event.pages.length === 1) {
      // The last page of an event cannot be deleted (the edit API refuses
      // it), so the repair clears the impossible self-switch clause instead,
      // keeping any other condition clauses. With no clauses left the whole
      // condition is removed.
      const { selfSwitch: _drop, ...conditionRest } = condition;
      const replacement: Page = { ...page };
      if (Object.keys(conditionRest).length > 0) replacement.condition = conditionRest;
      else delete replacement.condition;
      findings.push({
        check: "doctor/selfswitch-never-set",
        severity: "warning",
        message: `Page ${pageIndex + 1} needs self switch ${key} ON, but no page of this event (nor a common event it calls) ever sets it — the page can never run`,
        loc,
        fix: {
          label: "Remove the impossible condition",
          description: `Clears the self switch ${key} clause from the page condition, so the page is no longer gated on a switch nobody sets.`,
          ops: [{ command: "update-page", args: { map: map.id, event: event.id, page: pageIndex, value: replacement } }],
        },
      });
      return;
    }
    findings.push({
      check: "doctor/selfswitch-never-set",
      severity: "warning",
      message: `Page ${pageIndex + 1} needs self switch ${key} ON, but no page of this event (nor a common event it calls) ever sets it — the page can never run`,
      loc,
      fix: {
        label: "Delete the dead page",
        description: `Removes page ${pageIndex + 1}, whose condition can never be satisfied.`,
        ops: [{ command: "delete-page", args: { map: map.id, event: event.id, page: pageIndex } }],
      },
    });
  });
}

/** All fixable findings in a project's map events. */
export function doctorFindings(project: Project): DoctorFinding[] {
  const ctx: Ctx = {
    mapIds: new Set(project.maps.map((map) => map.id)),
    commonById: new Map((project.commonEvents ?? []).map((common) => [common.id, { commands: common.commands }])),
  };
  const findings: DoctorFinding[] = [];
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      event.pages.forEach((page, pageIndex) => checkPageCommands(map, event, page, pageIndex, ctx, findings));
      checkDeadPages(map, event, ctx, findings);
    }
    checkAutoruns(map, project, ctx, findings);
  }
  return findings;
}
