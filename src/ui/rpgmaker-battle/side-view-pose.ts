import { rpgMakerCombatantParam } from "../../rpgmaker-battle/rules.ts";
import type {
  RpgMakerBattleCombatant,
  RpgMakerBattleDatabase,
  RpgMakerBattleState,
} from "../../rpgmaker-battle/types.ts";

const MOTION_LOOP = new Set([0, 1, 2, 3, 12, 13, 14, 15, 16, 17]);

/** Derive all presentation timing from the saved 60 Hz reducer clock. */
export function sideViewPose(
  db: RpgMakerBattleDatabase,
  state: Readonly<RpgMakerBattleState>,
  actor: Readonly<RpgMakerBattleCombatant>,
  index: number,
): { motion: number; pattern: number; advance: number; weaponImageId: number; weaponPattern: number } {
  const elapsed = Math.max(0, state.nowTick - (state.sideViewMotion?.startTick ?? 0));
  const action = state.sideViewMotion?.side === "actor" && state.sideViewMotion.index === index && elapsed < 48
    ? state.sideViewMotion : null;
  const active = actor.states.map((entry) => db.states.find((definition) => definition.id === entry.id))
    .filter((entry) => entry !== undefined).sort((a, b) => b.priority - a.priority);
  const stateMotion = active[0]?.motion ?? 0;
  const base = actor.hp <= 0 ? 17 : stateMotion === 3 ? 17 : stateMotion === 2 ? 16
    : actor.guarding ? 3 : stateMotion === 1 ? 15 : actor.hp < rpgMakerCombatantParam(db, actor, 0) / 4 ? 14 : 1;
  const motion = action && elapsed < 36 ? action.motion : base;
  const frame = Math.floor((action && elapsed < 36 ? elapsed : state.nowTick) / 12);
  const phase = MOTION_LOOP.has(motion) ? frame % 4 : Math.min(2, frame);
  const advance = action ? elapsed < 12 ? elapsed / 12 : elapsed < 36 ? 1 : (48 - elapsed) / 12 : 0;
  return {
    motion, pattern: phase === 3 ? 1 : phase, advance: Math.max(0, advance),
    weaponImageId: action?.weaponImageId ?? 0,
    weaponPattern: Math.floor(elapsed / 12),
  };
}
