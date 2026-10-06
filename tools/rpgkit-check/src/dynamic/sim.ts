// tools/rpgkit-check/src/dynamic/sim.ts — shared session plumbing for the
// dynamic checks (locks, freeze, reach, explore).
//
// Every dynamic check drives the REAL engine (createSession/startSession/
// stepSession) on a copy of the project under test. Game-owned extension
// calls and battles are outside a generic QA tool's reach, so by default
// unknown extensions are accepted as no-ops and battles are declined
// (the same isolation the Tuxemon corpus probes used): the checks measure
// event/lock/world liveness, not game logic.

import type { BattleCompletion, BattleRules } from "../../../../src/engine/battle.ts";
import type { SceneRules } from "../../../../src/engine/scene.ts";
import type { Command, Dir, MapDef, Page, Project } from "../../../../src/engine/types.ts";
import {
  createSession,
  isSessionWorldIdle,
  startSession,
  stepSession,
  type Session,
  type SessionOptions,
  type SessionState,
} from "../../../../src/engine/session.ts";
import {
  createSwitchState,
  type ConditionContext,
  type EventPageAppearance,
  type SwitchState,
} from "../../../../src/engine/interpreter.ts";
import { flattenPageCondition } from "../conditions.ts";
import { walkCommands } from "../walk.ts";
import { NAME_INPUT_SCENE_ID } from "../../../../src/engine/name-input.ts";
import { NUMBER_INPUT_SCENE_ID } from "../../../../src/engine/number-input.ts";
import { SELECT_ITEM_SCENE_ID } from "../../../../src/engine/select-item.ts";

/** Built-in scene ids the engine compiles commands into (inputNumber,
 *  selectItem) or that a game may scene into explicitly (nameInput). They
 *  never appear as `scene` commands in the document, so the document walk
 *  below would not register rules for them; the session fail-fasts on a
 *  missing SceneRules, so the checker must register noop rules for them. */
const BUILT_IN_SCENE_IDS: readonly string[] = [
  NUMBER_INPUT_SCENE_ID,
  SELECT_ITEM_SCENE_ID,
  NAME_INPUT_SCENE_ID,
];

export const CHECK_HZ = 60;

/** How the player starts a page by hand, or null when the player cannot
 *  (autorun/parallel):
 *    "action"      stand in the rect or on a neighbor facing it, confirm;
 *    "playerTouch" step ONTO a rect cell (fires on entry) — also an
 *                  eventTouch page that does not block (it fires on entry);
 *    "bump"        an eventTouch page that blocks: stand on a neighbor and
 *                  press the direction toward the rect, so the player's step
 *                  is refused by the event's body. */
export type TouchMode = "action" | "playerTouch" | "bump";

export function pageTouchMode(page: Page): TouchMode | null {
  switch (page.trigger) {
    case "action":
      return "action";
    case "playerTouch":
      return "playerTouch";
    case "eventTouch":
      return page.blocks === true ? "bump" : "playerTouch";
    default:
      return null;
  }
}

/** Default battle isolation declines the encounter. This preserves the
 *  generic checker's historical behavior when no game contract is loaded. */
export const NOOP_BATTLE_RULES: BattleRules = {
  start: () => null,
  step: (state) => state,
  done: () => null,
};

export type SyntheticBattleCompletion = Omit<BattleCompletion, "ext">;

/** Build an immediate deterministic battle adapter for a game's QA session
 *  module. The caller declares its own result-variable/switch convention in
 *  `completion`; the checker must not guess game-specific ids or enum codes. */
export function syntheticBattleRules(completion: SyntheticBattleCompletion): BattleRules {
  return {
    start: (ext) => ({ state: ext, ext }),
    step: (state) => state,
    done: (ext) => ({ ...completion, ext }),
  };
}

/** Scene completes on its first frame with a normal (non-cancelled)
 *  completion: the parked fiber runs the scene's onDone branch, so the
 *  story after the scene stays live under exploration. Unlike a null
 *  start (which skips both branches), this exercises the normal
 *  continuation; onCancel paths are not modelled, same as battle outcome
 *  branches. */
export const NOOP_SCENE_RULES: SceneRules = {
  start: (ext) => ({ state: { kind: "rpgkit-check-noop-scene" }, ext }),
  step: (state) => state,
  done: () => ({}),
};

/** Every scene id referenced by the document (map events, common events,
 *  nested branches) must have a registered SceneRules or createSession
 *  throws. The checks measure event/lock/world liveness, not scene logic,
 *  so every id gets the shared noop rules. The engine's built-in scenes
 *  (inputNumber/selectItem/nameInput) are registered too: the first two
 *  are compiled from commands, not authored as `scene`, so the document
 *  walk would miss them. */
export function checkSceneRules(project: Project): Record<string, SceneRules> {
  const ids = new Set<string>(BUILT_IN_SCENE_IDS);
  const collect = (commands: readonly Command[]): void => {
    walkCommands(commands, (command) => {
      if (command.op === "scene") ids.add(command.id);
    });
  };
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) collect(page.commands);
    }
  }
  for (const common of project.commonEvents ?? []) collect(common.commands);
  return Object.fromEntries([...ids].map((id) => [id, NOOP_SCENE_RULES]));
}

/** The session options every dynamic check shares: unknown extensions are
 *  tolerated, battles are declined, and every scene id the document uses
 *  gets the noop scene rules. Game registrations override the fallbacks
 *  while unregistered scene ids retain a noop, which keeps partial QA
 *  profiles usable. */
export function checkSessionOptions(
  project: Project,
  overrides: SessionOptions = {},
): SessionOptions {
  return {
    ...overrides,
    extensions: { allowUnknown: true, ...overrides.extensions },
    battle: overrides.battle ?? NOOP_BATTLE_RULES,
    scenes: { ...checkSceneRules(project), ...overrides.scenes },
  };
}

export function makeCheckSession(
  project: Project,
  hz: number = CHECK_HZ,
  overrides?: SessionOptions,
): Session {
  return createSession(project, hz, checkSessionOptions(project, overrides));
}

export function startFresh(
  project: Project,
  session: Session,
  sw0?: SwitchState,
): SessionState {
  return startSession(project, session, sw0);
}

/** The switch state a reach search AND a witness replay both start from for
 *  a custom start. A fresh playthrough seeds `playerName` from
 *  `project.playerName` and `mapNameDisplay` from `system.mapNameDisplay`
 *  (session.ts startSession); a custom start must carry the same fields or a
 *  recorded witness replays to a different state hash (the search built a
 *  bank without them, the replay took the fresh-playthrough path with them).
 *  Both sides MUST go through this helper so the origin is constructed once,
 *  in one place. Returns undefined for the project's own start (the engine's
 *  fresh path is the reference). */
export function reachStartSwitchState(
  project: Project,
  start?: {
    switches?: Record<string, boolean>;
    variables?: Record<string, number>;
    items?: Record<string, number>;
    gold?: number;
  },
): SwitchState | undefined {
  if (!start) return undefined;
  const sw = createSwitchState({
    switches: start.switches,
    variables: start.variables,
    items: start.items,
    // Match the engine's fresh-playthrough seeding: an unspecified gold
    // falls back to the project's initialGold, not 0.
    gold: start.gold ?? project.initialGold ?? 0,
  });
  if (project.playerName) sw.playerName = project.playerName;
  if (project.system?.mapNameDisplay === true) sw.mapNameDisplay = true;
  return sw;
}

/** A project copy whose start lands elsewhere — the engine's own entry
 *  path (local-bank clear, page sync, character spawn) then runs for that
 *  map, exactly as a transfer would. */
export function projectWithStart(
  project: Project,
  map: string,
  x: number,
  y: number,
  dir: Dir = "down",
): Project {
  return { ...project, start: { map, x, y, dir } };
}

/** Drop per-visit `local.*` switch/variable ids, as the engine's private
 *  clearLocalBank does on every map entry. */
export function clearLocalBank(sw: SwitchState): void {
  for (const id of Object.keys(sw.switches)) {
    if (id.startsWith("local.")) delete sw.switches[id];
  }
  for (const id of Object.keys(sw.variables)) {
    if (id.startsWith("local.")) delete sw.variables[id];
  }
}

/** Flatten a page condition (flat fields ANDed with `all`) into the
 *  Condition list the engine evaluates. Re-exported from conditions.ts so
 *  dynamic checks have one import surface. */
export const pageConditions = flattenPageCondition;

/** A stable fingerprint of the world-level state, for freeze/progress
 *  detection: where the player is and every saved bank. Audio is deliberately
 *  excluded: a BGM cursor advances every tick and must not disguise a frozen
 *  gameplay fiber as world progress. */
export function worldFingerprint(state: SessionState): string {
  const entries = (record: Readonly<Record<string, unknown>>) =>
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    state.mapId,
    state.move.tx,
    state.move.ty,
    entries(state.sw.variables),
    entries(state.sw.switches),
    entries(state.sw.self),
    entries(state.sw.items),
    state.sw.gold,
  ]);
}

/** Drive one frame, auto-advancing any open text/choices modal (confirm on
 *  alternate frames, so a modal that opens this frame is observable). When
 *  `buttons` is supplied the d-pad is held unless a modal is open. */
export function stepAuto(
  session: Session,
  state: SessionState,
  frame: number,
  buttons = 0,
): SessionState {
  const modal = state.interp.modal;
  return stepSession(session, state, {
    buttons: modal ? 0 : buttons,
    confirmEdge: modal !== null && frame % 2 === 0,
    cancelEdge: false,
    upEdge: false,
    downEdge: false,
  });
}

export { createSwitchState };

/** The ConditionContext the engine itself would derive for this state, so a
 *  check tool's activePage/evalCondition calls see the same facts the runtime
 *  does: worldIdle, each live event's active page/sprite (for appearance
 *  conditions), persistent audio intent (for bgmPlaying), and the per-visit
 *  tileProperty overrides (for tileProperty conditions). Without it, runtime
 *  conditions can conservatively evaluate false and pages the engine really
 *  activates look dead to the checks. */
export function checkConditionContext(state: SessionState, map: MapDef): ConditionContext {
  const eventPages: Record<string, EventPageAppearance> = {};
  for (const ev of map.events ?? []) {
    const pageIndex = state.chars.chars[ev.id]?.pageIndex;
    if (pageIndex !== undefined && ev.pages[pageIndex]) {
      eventPages[ev.id] = { pageIndex, sprite: ev.pages[pageIndex]!.sprite ?? null };
    }
  }
  return {
    worldIdle: isSessionWorldIdle(state),
    audio: state.interp.audio,
    eventPages,
    eventAppearances: state.interp.eventAppearances,
    tileProperties: state.interp.tileProperties,
    mapWidth: map.width,
    mapHeight: map.height,
  };
}
