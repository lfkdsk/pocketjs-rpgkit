import { rpgMakerCombatantParam } from "../../rpgmaker-battle/rules.ts";
import type {
  RpgMakerBattleAction,
  RpgMakerBattleCombatant,
  RpgMakerBattleDatabase,
  RpgMakerBattleState,
} from "../../rpgmaker-battle/types.ts";

const MOTION_LOOP = new Set([0, 1, 2, 3, 12, 13, 14, 15, 16, 17]);
const ACTION_TICKS = 36;
const STEP_TICKS = 12;
const RETURN_TICKS = 12;
const ENTRY_TICKS = 30;
const ESCAPE_TICKS = 30;

export interface SideViewPose {
  /** Stock motion row, 0..17. */
  motion: number;
  /** Stock source pattern, including the looping 0,1,2,1 sequence. */
  pattern: number;
  /** 0..1 of the stock 48-pixel step toward the enemy. */
  advance: number;
  /** Stock rightward entry/escape offset in authored pixels. */
  retreat: number;
  weaponImageId: number;
  weaponPattern: number;
}

function pendingAction(
  state: Readonly<RpgMakerBattleState>,
  index: number,
): Readonly<RpgMakerBattleAction> | undefined {
  return state.actorActions.find((entry) => entry.side === "actor" && entry.user === index) ??
    state.queue.slice(state.queueIndex).find((entry) => entry.side === "actor" && entry.user === index);
}

function isMagicAction(
  db: Readonly<RpgMakerBattleDatabase>,
  action: Readonly<RpgMakerBattleAction> | undefined,
): boolean {
  if (action?.kind !== "skill") return false;
  const skill = db.skills.find((entry) => entry.id === action.id);
  return !!skill && db.magicSkillTypes?.includes(skill.stypeId) === true;
}

/** Highest-priority state follows Game_BattlerBase.sortStates: descending
 * priority, then ascending database id for ties. */
export function sideViewState(
  db: Readonly<RpgMakerBattleDatabase>,
  actor: Readonly<RpgMakerBattleCombatant>,
) {
  return actor.states.map((entry) => db.states.find((definition) => definition.id === entry.id))
    .filter((entry) => entry !== undefined)
    .sort((a, b) => b.priority - a.priority || a.id - b.id)[0];
}

/** Stock actor homes are (600 + i*32, 280 + i*48) on the canonical
 * 816x624 canvas. Normalize those coordinates so low-resolution projects
 * retain the same right-side composition. */
export function sideViewActorHome(
  width: number,
  height: number,
  index: number,
): { x: number; y: number } {
  return {
    x: (600 + index * 32) / 816 * width,
    y: (280 + index * 48) / 624 * height,
  };
}

/** Derive presentation solely from reducer-owned JSON and its integer 60 Hz
 * clock. Transient requests use their saved start ticks; old saves lacking
 * the additive input clock fall back to nowTick without becoming invalid. */
export function sideViewPose(
  db: RpgMakerBattleDatabase,
  state: Readonly<RpgMakerBattleState>,
  actor: Readonly<RpgMakerBattleCombatant>,
  index: number,
): SideViewPose {
  const actionElapsed = Math.max(0, state.nowTick - (state.sideViewMotion?.startTick ?? 0));
  const action = state.sideViewMotion?.side === "actor" && state.sideViewMotion.index === index &&
      actionElapsed < ACTION_TICKS + RETURN_TICKS
    ? state.sideViewMotion : null;
  const reactionElapsed = Math.max(0, state.nowTick - (state.effect?.startTick ?? 0));
  const reaction = state.effect?.side === "actor" && state.effect.index === index && reactionElapsed < ACTION_TICKS
    ? state.effect : null;
  const input = state.actorIndex === index &&
    (state.phase === "command" || state.phase === "skill" || state.phase === "item" || state.phase === "target");
  const inputElapsed = Math.max(0, state.nowTick - (state.sideViewInputStartTick ?? state.nowTick));
  const queued = pendingAction(state, index);
  const escaped = state.phase === "message" && state.afterMessage === "escape";
  const escaping = escaped || (state.phase === "message" && state.afterMessage === "turnStart");
  const escapeElapsed = Math.max(0, state.nowTick - state.messageStart);
  const victory = state.phase === "message" && state.afterMessage === "win";
  const entering = state.phase === "message" && state.afterMessage === "party" && state.nowTick < ENTRY_TICKS;

  const active = sideViewState(db, actor);
  const stateMotion = active?.motion ?? 0;
  const movable = actor.hp > 0 && stateMotion !== 3;
  const base = actor.hp <= 0 || stateMotion === 3 ? 17 : stateMotion === 2 ? 16
    : isMagicAction(db, queued) ? 2
      : actor.guarding || queued?.kind === "guard" ? 3
        : stateMotion === 1 ? 15
          : actor.hp < rpgMakerCombatantParam(db, actor, 0) / 4 ? 14 : 1;

  // Requested one-shot motions win over refreshMotion, just as setupMotion()
  // runs before refreshMotion() in Sprite_Actor.updateMotion().
  let motion = base;
  let anchor = queued ? (state.sideViewInputStartTick ?? 0) : 0;
  if (actor.guarding && state.sideViewMotion?.side === "actor" && state.sideViewMotion.index === index &&
      state.sideViewMotion.motion === 3) anchor = state.sideViewMotion.startTick;
  if ((actor.hp <= 0 || stateMotion > 0) && state.effect?.side === "actor" && state.effect.index === index) {
    anchor = state.effect.startTick + ACTION_TICKS;
  }
  if (action && actionElapsed < ACTION_TICKS) {
    motion = action.motion;
    anchor = action.startTick;
  } else if (reaction) {
    motion = reaction.kind === "evade" ? 5 : 4;
    anchor = reaction.startTick;
  } else if (victory && movable) {
    motion = 13;
    anchor = state.messageStart;
  } else if (escaping && movable) {
    motion = 12;
    anchor = state.messageStart;
  } else if (input) {
    motion = 0;
    anchor = state.sideViewInputStartTick ?? state.nowTick;
  } else if (entering && movable) {
    motion = 0;
  }

  const frame = Math.floor(Math.max(0, state.nowTick - anchor) / 12);
  const phase = MOTION_LOOP.has(motion) ? frame % 4 : Math.min(2, frame);
  let advance = 0;
  if (action) {
    advance = actionElapsed < STEP_TICKS ? actionElapsed / STEP_TICKS
      : actionElapsed < ACTION_TICKS ? 1
        : Math.max(0, (ACTION_TICKS + RETURN_TICKS - actionElapsed) / RETURN_TICKS);
  } else if (input) {
    advance = Math.min(1, inputElapsed / STEP_TICKS);
  } else if (queued && inputElapsed < RETURN_TICKS) {
    // Enqueuing the prior actor and selecting the next actor happen in the
    // same reducer transition, so the next input clock is also the return
    // movement's deterministic anchor.
    advance = Math.max(0, 1 - inputElapsed / RETURN_TICKS);
  }

  const retreat = escaped && movable
    ? 300 * Math.min(1, escapeElapsed / ESCAPE_TICKS)
    : entering && movable ? 300 * Math.max(0, 1 - state.nowTick / ENTRY_TICKS) : 0;
  const weaponActive = action && actionElapsed < ACTION_TICKS && action.weaponImageId > 0;
  return {
    motion,
    pattern: phase === 3 ? 1 : phase,
    advance,
    retreat,
    weaponImageId: weaponActive ? action.weaponImageId : 0,
    weaponPattern: weaponActive ? Math.floor(actionElapsed / 12) : 3,
  };
}
