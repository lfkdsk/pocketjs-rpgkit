// Optional front-view renderer for the pure RPG Maker battle reducer.
// This module is reachable only through `./ui/rpgmaker-battle`; games that
// do not import it pay no bundle or per-frame cost.

import { For, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { BattleSceneComponent, BattleSceneViewProps } from "../GameView.tsx";
import {
  CommandGrid,
  createBattleImageCache,
  ListMenu,
  MessageBand,
  SpriteSlot,
  StatBar,
  tweenAt,
  type CommandCell,
  type RpgImageSource,
  type SpriteEffect,
} from "../battle/index.ts";
import {
  rpgMakerBattleState,
  rpgMakerCombatantParam,
  rpgMakerItemChoices,
  rpgMakerMessageRevealed,
  rpgMakerSkillChoices,
} from "../../rpgmaker-battle/rules.ts";
import type {
  RpgMakerBattleCombatant,
  RpgMakerBattleDatabase,
  RpgMakerBattleState,
} from "../../rpgmaker-battle/types.ts";

export interface RpgMakerBattleSceneOptions {
  /** Normalized enemy image id -> baked image source. */
  enemyImages?: Readonly<Record<string, RpgImageSource>>;
  background?: string;
}

const NONE: SpriteEffect = { kind: "none", startTick: 0, duration: 0 };

function effectFor(
  state: Readonly<RpgMakerBattleState>,
  side: "actor" | "enemy",
  index: number,
): SpriteEffect {
  const effect = state.effect;
  if (!effect || effect.side !== side || effect.index !== index) return NONE;
  return {
    kind: effect.kind === "hit" ? "shake" : effect.kind === "heal" ? "flash" : "faint",
    startTick: effect.startTick,
    duration: effect.duration,
  };
}

function shownHp(state: Readonly<RpgMakerBattleState>, side: "actor" | "enemy", index: number): number {
  const battler = side === "actor" ? state.actors[index] : state.enemies[index];
  if (!battler) return 0;
  const effect = state.effect;
  return effect && effect.side === side && effect.index === index
    ? tweenAt({ from: effect.from, to: effect.to, startTick: effect.startTick, duration: effect.duration }, state.nowTick)
    : battler.hp;
}

function targetRows(db: RpgMakerBattleDatabase, state: Readonly<RpgMakerBattleState>): {
  battlers: readonly RpgMakerBattleCombatant[];
  indices: number[];
} {
  const selected = state.selected;
  const usable = selected
    ? selected.kind === "skill"
      ? db.skills.find((entry) => entry.id === selected.id)
      : db.items.find((entry) => entry.id === selected.id)
    : undefined;
  const actorSide = usable ? usable.scope >= 7 : false;
  const battlers = actorSide ? state.actors : state.enemies;
  const dead = usable?.scope === 9;
  return {
    battlers,
    indices: battlers.flatMap((entry, index) => entry.hidden || (dead ? entry.hp > 0 : entry.hp <= 0) ? [] : [index]),
  };
}

function FrontViewScene(
  db: RpgMakerBattleDatabase,
  options: RpgMakerBattleSceneOptions,
  props: BattleSceneViewProps,
) {
  const imageCache = createBattleImageCache(() => props.active, { maxEntries: 12 });
  const state = () => rpgMakerBattleState(props.state);
  const troop = () => db.troops.find((entry) => entry.id === state().troopId);
  const commandCells = (): readonly [CommandCell, CommandCell, CommandCell, CommandCell] => [
    { label: db.terms.attack },
    { label: db.terms.skill },
    { label: db.terms.guard },
    { label: db.terms.item },
  ];
  const skills = () => rpgMakerSkillChoices(db, state());
  const items = () => rpgMakerItemChoices(db, state());
  const targets = () => targetRows(db, state());
  const menuWidth = () => Math.min(232, Math.max(160, props.width - 16));

  return (
    <View
      class="absolute"
      style={{
        posType: 1,
        insetL: 0,
        insetT: 0,
        width: props.width,
        height: props.height,
        bgColor: options.background ?? "#162536",
      }}
      debugName="rpgmaker-battle-scene"
    >
      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: 0,
          insetT: Math.floor(props.height * 0.36),
          width: props.width,
          height: Math.ceil(props.height * 0.64),
          bgColor: "#24394a",
        }}
        debugName="rpgmaker-battle-floor"
      />

      <For each={state().enemies}>
        {(enemy, index) => {
          const member = () => troop()?.members[index()];
          const size = () => Math.max(48, Math.min(96, Math.floor(props.height * 0.24)));
          const x = () => member()
            ? clampPosition(member()!.x / 816 * props.width - size() / 2, 8, props.width - size() - 8)
            : (index() + 1) * props.width / (state().enemies.length + 1) - size() / 2;
          const y = () => member()
            ? clampPosition(member()!.y / 624 * props.height - size() / 2, 20, props.height * 0.48)
            : 32;
          const source = () => enemy.image ? options.enemyImages?.[enemy.image] : undefined;
          return (
            <Show when={!enemy.hidden}>
              <View
                class="absolute"
                style={{ posType: 1, insetL: x(), insetT: Math.max(4, y() - 16), width: size() }}
                debugName={`rpgmaker-enemy-hud-${index()}`}
              >
                <Text class="text-xs" style={{ textColor: "#ffffff", height: 12, lineHeight: 12 }}>
                  {enemy.name}
                </Text>
                <StatBar
                  current={shownHp(state(), "enemy", index())}
                  max={rpgMakerCombatantParam(db, enemy, 0)}
                  width={size()}
                  fill="#e85d75"
                  debugName={`rpgmaker-enemy-hp-${index()}`}
                />
              </View>
              <Show
                when={source()}
                fallback={(
                  <View
                    class="absolute items-center justify-center"
                    style={{ posType: 1, insetL: x(), insetT: y(), width: size(), height: size(), bgColor: "#6a7180" }}
                    debugName={`rpgmaker-enemy-placeholder-${index()}`}
                  >
                    <Text class="text-xs" style={{ textColor: "#ffffff" }}>{enemy.name}</Text>
                  </View>
                )}
              >
                <SpriteSlot
                  src={source()!}
                  cache={imageCache}
                  active={props.active}
                  x={x()}
                  y={y()}
                  width={size()}
                  height={size()}
                  effect={effectFor(state(), "enemy", index())}
                  nowTick={state().nowTick}
                  debugName={`rpgmaker-enemy-sprite-${index()}`}
                />
              </Show>
            </Show>
          );
        }}
      </For>

      <View
        class="absolute flex-col"
        style={{ posType: 1, insetL: 8, insetB: 8, width: Math.min(210, Math.max(120, props.width * 0.42)) }}
        debugName="rpgmaker-party-hud"
      >
        <For each={state().actors}>
          {(actor, index) => (
            <View class="flex-col" style={{ height: 30 }} debugName={`rpgmaker-actor-hud-${index()}`}>
              <Text class="text-xs" style={{ textColor: "#ffffff", height: 14, lineHeight: 14 }}>
                {`${actor.name}  Lv ${actor.actor?.level ?? 1}  MP ${actor.mp}`}
              </Text>
              <StatBar
                current={shownHp(state(), "actor", index())}
                max={rpgMakerCombatantParam(db, actor, 0)}
                width={Math.min(210, Math.max(120, props.width * 0.42))}
                showNumbers
                debugName={`rpgmaker-actor-hp-${index()}`}
              />
            </View>
          )}
        </For>
      </View>

      <Show when={state().phase === "message"}>
        <MessageBand
          lines={state().message.split("\n")}
          revealed={rpgMakerMessageRevealed(state())}
          legend="OK"
          width={props.width - 16}
          style={{ insetL: 8, insetB: 8 }}
          debugName="rpgmaker-battle-message"
        />
      </Show>
      <Show when={state().phase === "party"}>
        <ListMenu
          title={state().actors[0]?.name ?? "Party"}
          rows={[
            { label: db.terms.fight },
            { label: db.terms.escape, disabled: !state().canEscape },
          ]}
          index={state().menuIndex}
          width={menuWidth()}
          style={{ insetR: 8, insetB: 8 }}
          debugName="rpgmaker-party-command"
        />
      </Show>
      <Show when={state().phase === "command"}>
        <CommandGrid
          cells={commandCells()}
          index={state().menuIndex}
          tick={state().nowTick}
          style={{ insetR: 8, insetB: 8 }}
          debugName="rpgmaker-actor-command"
        />
      </Show>
      <Show when={state().phase === "skill"}>
        <ListMenu
          title={db.terms.skill}
          rows={skills().map((skill) => ({
            label: skill.name,
            detail: skill.mpCost > 0 ? `MP ${skill.mpCost}` : skill.tpCost > 0 ? `TP ${skill.tpCost}` : "",
            disabled: state().actors[state().actorIndex]!.mp < skill.mpCost ||
              state().actors[state().actorIndex]!.tp < skill.tpCost,
          }))}
          index={state().listIndex}
          description={skills()[state().listIndex]?.description}
          width={menuWidth()}
          style={{ insetR: 8, insetB: 8 }}
          debugName="rpgmaker-skill-menu"
        />
      </Show>
      <Show when={state().phase === "item"}>
        <ListMenu
          title={db.terms.item}
          rows={items().map((item) => ({ label: item.name, detail: `x${state().items[`item${String(item.id).padStart(3, "0")}`] ?? 0}` }))}
          index={state().listIndex}
          description={items()[state().listIndex]?.description}
          width={menuWidth()}
          style={{ insetR: 8, insetB: 8 }}
          debugName="rpgmaker-item-menu"
        />
      </Show>
      <Show when={state().phase === "target"}>
        <ListMenu
          title="Target"
          rows={targets().indices.map((index) => ({ label: targets().battlers[index]!.name }))}
          index={Math.max(0, targets().indices.indexOf(state().targetIndex))}
          width={menuWidth()}
          style={{ insetR: 8, insetB: 8 }}
          debugName="rpgmaker-target-menu"
        />
      </Show>
    </View>
  );
}

function clampPosition(value: number, lo: number, hi: number): number {
  return Math.round(Math.max(lo, Math.min(hi, value)));
}

export function createRpgMakerBattleScene(
  database: RpgMakerBattleDatabase,
  options: RpgMakerBattleSceneOptions = {},
): BattleSceneComponent {
  return (props) => FrontViewScene(database, options, props);
}
