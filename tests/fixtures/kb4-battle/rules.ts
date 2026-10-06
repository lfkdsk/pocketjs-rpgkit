// tests/fixtures/kb4-battle/rules.ts — a richer toy BattleRules than
// tests/fixtures/toy-battle.ts (which KB2's own tests pin exact behaviour
// to and must not change). This one exists only to give KB4's components
// (src/ui/battle/) something real to drive: a command grid, a skill
// submenu, HP tweens, hit shake, a faint sink/fade and win/lose messages.
//
// Every animated beat (a message + an HP tween + a sprite effect) commits
// its OUTCOME instantly when chosen (damage is rolled and HP written
// immediately) and only plays it back over `beatDuration` reference
// ticks, so a rewind to any tick mid-beat, or the same fight folded at a
// different host Hz, reproduces identical pixels: nothing here depends on
// a wall clock or a host frame count, only on `nowTick`, which is itself
// state.

import { deepClone } from "../../../src/engine/clone.ts";
import { rngNext } from "../../../src/engine/interpreter.ts";
import type { BattleCompletion, BattleResult, BattleRules } from "../../../src/engine/battle.ts";
import type { JsonValue } from "../../../src/engine/types.ts";
import type { SpriteEffect, Tween } from "../../../src/ui/battle/index.ts";

// contracts/spec/spec.ts BTN.* bit values. BattleInput only derives
// up/down edges (engine/session.ts mirrors GameView's own fold); this
// ruleset derives left/right the same way, from the raw mask it already
// tracks in `lastButtons`.
const BTN_RIGHT = 0x0020;
const BTN_LEFT = 0x0080;

const BEAT_BASE_TICKS = 20;
const CHARS_PER_TICK = 1;

export interface Fighter {
  name: string;
  hp: number;
  maxHp: number;
}

type AfterBeat =
  | "toCommand"
  | "enemyTurn"
  | "checkEnemyFaint"
  | "checkPlayerFaint"
  | "winMessage"
  | "loseMessage"
  | "win"
  | "lose"
  | "escape";

type EffectSide = "none" | "player" | "enemy";

export interface Skill {
  name: string;
  power: number;
  disabled?: boolean;
}

export const SKILLS: readonly Skill[] = [
  { name: "Ember", power: 5 },
  { name: "Slash", power: 3 },
  { name: "Overload", power: 12, disabled: true },
];

export interface DemoBattleState {
  rng: number;
  nowTick: number;
  lastButtons: number;
  phase: "command" | "skills" | "beat" | "done";
  player: Fighter;
  enemy: Fighter;
  commandIndex: number;
  skillIndex: number;
  guarding: boolean;
  message: string;
  beatStart: number;
  beatDuration: number;
  effectSide: EffectSide;
  effectKind: "none" | "shake" | "faint";
  tweenSide: EffectSide;
  tweenFrom: number;
  afterBeat: AfterBeat | null;
  pending: BattleResult | null;
  turn: number;
  ext: JsonValue;
  /** The faint effect descriptor a downed fighter keeps once its own faint
   *  beat ends: later beats (the win/lose message) reset effectSide/Kind
   *  back to "none" so a NEW beat can own them, but a fighter at 0 HP must
   *  stay in its settled sunk/faded pose rather than reappear at rest —
   *  faintPose() already holds the terminal pose once `nowTick` passes
   *  startTick+duration, so keeping the same descriptor around (instead of
   *  clearing it with the rest of the beat fields) is enough. */
  enemyFainted: SpriteEffect | null;
  playerFainted: SpriteEffect | null;
}

interface DemoSetup {
  skip?: boolean;
  playerName?: string;
  playerHp?: number;
  enemyName?: string;
  enemyHp?: number;
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function setupOf(value: JsonValue): DemoSetup {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as unknown as DemoSetup)
    : {};
}

export function demoState(value: JsonValue): Readonly<DemoBattleState> {
  return value as unknown as DemoBattleState;
}

function stateJson(state: DemoBattleState): JsonValue {
  return state as unknown as JsonValue;
}

function draw(state: DemoBattleState, span: number): number {
  const result = rngNext(state.rng);
  state.rng = result.next;
  return Math.floor(result.value * span);
}

function startBeat(
  state: DemoBattleState,
  message: string,
  effectSide: EffectSide,
  effectKind: "none" | "shake" | "faint",
  tweenSide: EffectSide,
  tweenFrom: number,
  afterBeat: AfterBeat,
): void {
  state.phase = "beat";
  state.message = message;
  state.beatStart = state.nowTick;
  state.beatDuration = Math.max(BEAT_BASE_TICKS, message.length * CHARS_PER_TICK + 10);
  state.effectSide = effectSide;
  state.effectKind = effectKind;
  state.tweenSide = tweenSide;
  state.tweenFrom = tweenFrom;
  state.afterBeat = afterBeat;
}

/** The command-grid attack: instant damage, then a shake+tween beat on the
 *  target, exactly as an autonomous replay would reproduce it. */
function resolveAttack(state: DemoBattleState, power: number, label: string): void {
  state.turn++;
  const dmg = power + draw(state, 3);
  const before = state.enemy.hp;
  state.enemy.hp = Math.max(0, state.enemy.hp - dmg);
  startBeat(
    state,
    `${state.player.name} used ${label}!\nDealt ${dmg} damage.`,
    "enemy",
    "shake",
    "enemy",
    before,
    state.enemy.hp === 0 ? "checkEnemyFaint" : "enemyTurn",
  );
}

function resolveEnemyTurn(state: DemoBattleState): void {
  const raw = 3 + draw(state, 4);
  const dmg = state.guarding ? Math.max(1, Math.floor(raw / 2)) : raw;
  state.guarding = false;
  const before = state.player.hp;
  state.player.hp = Math.max(0, state.player.hp - dmg);
  startBeat(
    state,
    `${state.enemy.name} strikes back!\nYou take ${dmg} damage.`,
    "player",
    "shake",
    "player",
    before,
    state.player.hp === 0 ? "checkPlayerFaint" : "toCommand",
  );
}

/** BattleRules.start(): a small, self-contained turn-based skirmish driving
 *  the KB4 primitives (command grid, skill list, HP tween, shake, faint). */
export const kb4BattleRules: BattleRules = {
  start(ext, rawSetup, seed) {
    const setup = setupOf(rawSetup);
    if (setup.skip) return null;
    const state: DemoBattleState = {
      rng: seed >>> 0,
      nowTick: 0,
      lastButtons: 0,
      phase: "command",
      player: { name: setup.playerName ?? "Rockitten", hp: setup.playerHp ?? 24, maxHp: setup.playerHp ?? 24 },
      enemy: { name: setup.enemyName ?? "Budaye", hp: setup.enemyHp ?? 18, maxHp: setup.enemyHp ?? 18 },
      commandIndex: 0,
      skillIndex: 0,
      guarding: false,
      message: "",
      beatStart: 0,
      beatDuration: 0,
      effectSide: "none",
      effectKind: "none",
      tweenSide: "none",
      tweenFrom: 0,
      afterBeat: null,
      pending: null,
      turn: 0,
      ext,
      enemyFainted: null,
      playerFainted: null,
    };
    startBeat(
      state,
      `A wild ${state.enemy.name} appears!`,
      "none",
      "none",
      "none",
      0,
      "toCommand",
    );
    return { state: stateJson(state), ext };
  },

  step(rawState, input, ticks) {
    const state = deepClone(demoState(rawState)) as DemoBattleState;
    state.nowTick += ticks;
    const pressed = input.buttons & ~state.lastButtons;
    state.lastButtons = input.buttons >>> 0;
    if (state.phase === "done") return stateJson(state);

    if (state.phase === "beat") {
      const ready = state.nowTick >= state.beatStart + state.beatDuration;
      if (ready && input.confirmEdge) {
        const next = state.afterBeat;
        state.effectSide = "none";
        state.effectKind = "none";
        state.tweenSide = "none";
        state.afterBeat = null;
        if (next === "toCommand") {
          state.phase = "command";
          state.message = "";
        } else if (next === "enemyTurn") {
          resolveEnemyTurn(state);
        } else if (next === "checkEnemyFaint") {
          startBeat(state, `${state.enemy.name} fainted!`, "enemy", "faint", "none", 0, "winMessage");
          state.enemyFainted = { kind: "faint", startTick: state.beatStart, duration: state.beatDuration };
        } else if (next === "checkPlayerFaint") {
          startBeat(state, `${state.player.name} fainted...`, "player", "faint", "none", 0, "loseMessage");
          state.playerFainted = { kind: "faint", startTick: state.beatStart, duration: state.beatDuration };
        } else if (next === "winMessage") {
          startBeat(state, "You win!", "none", "none", "none", 0, "win");
        } else if (next === "loseMessage") {
          startBeat(state, "You lost...", "none", "none", "none", 0, "lose");
        } else if (next === "win" || next === "lose" || next === "escape") {
          state.pending = next === "win" ? "win" : next === "lose" ? "lose" : "escape";
          state.phase = "done";
        }
      }
      return stateJson(state);
    }

    if (state.phase === "skills") {
      if (input.cancelEdge) {
        state.phase = "command";
        return stateJson(state);
      }
      if (input.upEdge) state.skillIndex = Math.max(0, state.skillIndex - 1);
      if (input.downEdge) state.skillIndex = Math.min(SKILLS.length - 1, state.skillIndex + 1);
      if (input.confirmEdge) {
        const skill = SKILLS[state.skillIndex]!;
        if (!skill.disabled) resolveAttack(state, skill.power, skill.name);
      }
      return stateJson(state);
    }

    // phase === "command": 2x2 grid, row-major [Fight,Skill; Guard,Run].
    if (input.upEdge || input.downEdge) {
      state.commandIndex = state.commandIndex < 2 ? state.commandIndex + 2 : state.commandIndex - 2;
    }
    if ((pressed & BTN_LEFT) !== 0 || (pressed & BTN_RIGHT) !== 0) {
      state.commandIndex = state.commandIndex % 2 === 0 ? state.commandIndex + 1 : state.commandIndex - 1;
    }
    if (input.confirmEdge) {
      if (state.commandIndex === 0) resolveAttack(state, 4, "Tackle");
      else if (state.commandIndex === 1) state.phase = "skills";
      else if (state.commandIndex === 2) {
        state.turn++;
        state.guarding = true;
        startBeat(state, `${state.player.name} braces for the next hit.`, "none", "none", "none", 0, "enemyTurn");
      } else {
        state.turn++;
        const escaped = draw(state, 100) < 50;
        startBeat(
          state,
          escaped ? "Got away safely!" : "Couldn't escape!",
          "none",
          "none",
          "none",
          0,
          escaped ? "escape" : "enemyTurn",
        );
      }
    }
    return stateJson(state);
  },

  done(rawState): BattleCompletion | null {
    const state = demoState(rawState);
    if (state.phase !== "done" || state.pending === null) return null;
    const previous = record(state.ext).kb4Results;
    const results: JsonValue[] = Array.isArray(previous) ? [...previous] : [];
    results.push(state.pending);
    return {
      ext: { ...record(state.ext), kb4Results: results },
      result: state.pending,
      writes: { "kb4.result": state.pending, "kb4.turns": state.turn },
      switches: { [`kb4.result.${state.pending}`]: true },
    };
  },
};

/** The enemy's HP tween for the current beat, or a settled Tween (no
 *  animation) outside one — the presentation layer never special-cases
 *  "no beat", it just gets a Tween whose from equals its to. */
export function enemyHpTween(state: Readonly<DemoBattleState>): Tween {
  const to = state.enemy.hp;
  return state.phase === "beat" && state.tweenSide === "enemy"
    ? { from: state.tweenFrom, to, startTick: state.beatStart, duration: state.beatDuration }
    : { from: to, to, startTick: 0, duration: 0 };
}

export function playerHpTween(state: Readonly<DemoBattleState>): Tween {
  const to = state.player.hp;
  return state.phase === "beat" && state.tweenSide === "player"
    ? { from: state.tweenFrom, to, startTick: state.beatStart, duration: state.beatDuration }
    : { from: to, to, startTick: 0, duration: 0 };
}

const NONE_EFFECT: SpriteEffect = { kind: "none", startTick: 0, duration: 0 };

export function enemyEffect(state: Readonly<DemoBattleState>): SpriteEffect {
  if (state.phase === "beat" && state.effectSide === "enemy") {
    return { kind: state.effectKind, startTick: state.beatStart, duration: state.beatDuration };
  }
  return state.enemyFainted ?? NONE_EFFECT;
}

export function playerEffect(state: Readonly<DemoBattleState>): SpriteEffect {
  if (state.phase === "beat" && state.effectSide === "player") {
    return { kind: state.effectKind, startTick: state.beatStart, duration: state.beatDuration };
  }
  return state.playerFainted ?? NONE_EFFECT;
}

/** Message reveal count for the current beat's typewriter, or the command
 *  prompt (no message: 0 lines) between beats. */
export function messageRevealed(state: Readonly<DemoBattleState>): number {
  if (state.phase !== "beat") return 0;
  return Math.min(state.message.length, Math.max(0, state.nowTick - state.beatStart) * CHARS_PER_TICK);
}
