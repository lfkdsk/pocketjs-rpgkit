// Optional front-view renderer for the pure RPG Maker battle reducer.
// This module is reachable only through `./ui/rpgmaker-battle`; games that
// do not import it pay no bundle or per-frame cost.

import { createMemo, For, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { BattleSceneComponent, BattleSceneViewProps } from "../GameView.tsx";
import { BoundedLine } from "../BoundedLine.tsx";
import { fitBounded } from "../list-window.ts";
import { slotMeasure } from "../text-measure.ts";
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
import { ScreenToneWeatherLayer } from "../ScreenToneWeatherLayer.tsx";
import { screenToneWeatherActive } from "../screen-presentation.ts";
import { LazyImage } from "../LazyImage.tsx";
import { rpgMakerFaceSource } from "../rpgmaker-face.ts";
import {
  battleAnimationPlacement,
  battleAnimationPresentationAt,
  type BattleAnimationTargetRect,
  type RpgMakerBattleAnimationAsset,
} from "./animation-presentation.ts";

export type {
  RpgMakerBattleAnimationAsset,
  RpgMakerBattleAnimationTiming,
} from "./animation-presentation.ts";

export interface RpgMakerBattleSceneOptions {
  /** Normalized enemy image id -> baked image source. */
  enemyImages?: Readonly<Record<string, RpgImageSource>>;
  /** Exact `faceName:faceIndex` -> importer-cut actor face cell. */
  faces?: Readonly<Record<string, string>>;
  /** Exact RPG Maker battleback basename -> baked image source. */
  battlebacks1?: Readonly<Record<string, RpgImageSource>>;
  battlebacks2?: Readonly<Record<string, RpgImageSource>>;
  /** Cooked legacy MV animation id -> deterministic render assets. */
  animations?: Readonly<Record<string, RpgMakerBattleAnimationAsset>>;
  background?: string;
  /** Words absent from RPG Maker's own System.terms table. */
  text?: Partial<RpgMakerBattleUiText>;
}

export interface RpgMakerBattleUiText {
  ok: string;
  target: string;
  party: string;
}

export const RPGMAKER_BATTLE_UI_TEXT: Readonly<RpgMakerBattleUiText> = {
  ok: "OK",
  target: "Target",
  party: "Party",
};

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

type BattleAnimationMarker = NonNullable<RpgMakerBattleState["battleAnimation"]> & {
  /** Absent on v1 saves and troop-event animations, which target enemies. */
  targetSide?: "actor" | "enemy";
};

interface IndexedBattleTarget extends BattleAnimationTargetRect {
  side: "actor" | "enemy";
  index: number;
}

function enemyTargetRect(
  screen: Readonly<{ width: number; height: number }>,
  member: Readonly<{ x: number; y: number }> | undefined,
  index: number,
  count: number,
  width: number,
  height: number,
): BattleAnimationTargetRect {
  const size = Math.max(48, Math.min(96, Math.floor(height * 0.24)));
  const x = member
    ? clampPosition(member.x / screen.width * width - size / 2, 8, width - size - 8)
    : (index + 1) * width / (count + 1) - size / 2;
  const y = member
    ? clampPosition(
        member.y / screen.height * height - size / 2,
        20,
        Math.min(height * 0.48, height - 104 - size),
      )
    : 32;
  return { x, y, width: size, height: size };
}

function FrontViewScene(
  db: RpgMakerBattleDatabase,
  options: RpgMakerBattleSceneOptions,
  props: BattleSceneViewProps,
) {
  const imageCache = createBattleImageCache(() => props.active, { maxEntries: 12 });
  const text = { ...RPGMAKER_BATTLE_UI_TEXT, ...options.text };
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
  const actorWidth = () => Math.min(210, Math.max(120, props.width * 0.42));
  const battleback1 = () => {
    const name = state().settings?.battleback1Name;
    return name ? options.battlebacks1?.[name] : undefined;
  };
  const battleback2 = () => {
    const name = state().settings?.battleback2Name;
    return name ? options.battlebacks2?.[name] : undefined;
  };
  const enemyRect = (index: number): BattleAnimationTargetRect => enemyTargetRect(
    db.screen,
    troop()?.members[index],
    index,
    state().enemies.length,
    props.width,
    props.height,
  );
  const actorRect = (index: number): BattleAnimationTargetRect => ({
    x: 8,
    y: props.height - 8 - state().actors.length * 30 + index * 30,
    width: actorWidth(),
    height: 30,
  });
  const animationMarker = (): BattleAnimationMarker | undefined =>
    state().battleAnimation ?? undefined;
  const animationTargetSide = (): "actor" | "enemy" => animationMarker()?.targetSide ?? "enemy";
  const animationAsset = () => {
    const marker = animationMarker();
    return marker ? options.animations?.[marker.id] : undefined;
  };
  const animationPresentation = createMemo(() => {
    const marker = animationMarker();
    const asset = animationAsset();
    return marker && asset
      ? battleAnimationPresentationAt(asset, marker.startTick, state().nowTick)
      : undefined;
  });
  const animationTargetRects = (): readonly IndexedBattleTarget[] => {
    const marker = animationMarker();
    if (!marker) return [];
    const side = animationTargetSide();
    return marker.targets.flatMap((index): IndexedBattleTarget[] => {
      if (side === "enemy") {
        const enemy = state().enemies[index];
        return !enemy || enemy.hidden ? [] : [{ ...enemyRect(index), side, index }];
      }
      return state().actors[index] ? [{ ...actorRect(index), side, index }] : [];
    });
  };
  const animationPlacements = () => {
    const asset = animationAsset();
    const mirror = animationMarker()?.mirror === true;
    if (!asset) return [];
    if (asset.position === 3) {
      return [{ ...battleAnimationPlacement(asset, props, undefined, mirror), key: "screen" }];
    }
    return animationTargetRects().map((target) => ({
      ...battleAnimationPlacement(asset, props, target, mirror),
      key: `${target.side}-${target.index}`,
    }));
  };
  const animationFrameSource = () => {
    const asset = animationAsset();
    const index = animationPresentation()?.frameIndex ?? -1;
    return asset && index >= 0 ? asset.frames[index] : undefined;
  };
  const animationHidesTarget = (side: "actor" | "enemy", index: number): boolean =>
    animationPresentation()?.hideTargets === true &&
    animationTargetSide() === side &&
    animationMarker()?.targets.includes(index) === true;
  const targetFlash = () => animationPresentation()?.targetFlash;
  const screenFlash = () => animationPresentation()?.screenFlash;
  const actorFace = (actor: Readonly<RpgMakerBattleCombatant>): string | undefined =>
    db.flavor === "MZ"
      ? rpgMakerFaceSource(options.faces, actor.actor?.faceName, actor.actor?.faceIndex)
      : undefined;
  const ActorHudLines = (lineProps: {
    actor: RpgMakerBattleCombatant;
    index: number;
    width: number;
  }) => (
    <>
      <BoundedLine
        cell={fitBounded([
          lineProps.actor.name,
          `${db.terms.basic.levelAbbr} ${lineProps.actor.actor?.level ?? 1}`,
          `${db.terms.basic.mpAbbr} ${lineProps.actor.mp}`,
          ...(db.displayTp ? [`${db.terms.basic.tpAbbr} ${lineProps.actor.tp}`] : []),
        ].join("  "), lineProps.width, 1, slotMeasure())}
        tick={() => state().nowTick}
        textColor="#ffffff"
        rowH={14}
        width={lineProps.width}
        debugName={`rpgmaker-actor-name-${lineProps.index}`}
      />
      <StatBar
        current={shownHp(state(), "actor", lineProps.index)}
        max={rpgMakerCombatantParam(db, lineProps.actor, 0)}
        width={lineProps.width}
        showNumbers
        uiText={props.uiText}
        theme={props.theme}
        debugName={`rpgmaker-actor-hp-${lineProps.index}`}
      />
    </>
  );

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

      <Show when={battleback1()}>
        <LazyImage
          class="absolute"
          src={battleback1()!}
          cache={imageCache}
          active={props.active}
          style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height }}
          debugName="rpgmaker-battleback-1"
        />
      </Show>
      <Show when={battleback2()}>
        <LazyImage
          class="absolute"
          src={battleback2()!}
          cache={imageCache}
          active={props.active}
          style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height }}
          debugName="rpgmaker-battleback-2"
        />
      </Show>

      <For each={state().enemies}>
        {(enemy, index) => {
          const rect = () => enemyRect(index());
          const source = () => enemy.image ? options.enemyImages?.[enemy.image] : undefined;
          return (
            <Show when={!enemy.hidden}>
              <View
                class="absolute flex-col"
                style={{ posType: 1, insetL: rect().x, insetT: Math.max(4, rect().y - 16), width: rect().width }}
                debugName={`rpgmaker-enemy-hud-${index()}`}
              >
                <BoundedLine
                  cell={fitBounded(enemy.name, rect().width, 1, slotMeasure())}
                  tick={() => state().nowTick}
                  textColor="#ffffff"
                  rowH={12}
                  width={rect().width}
                  debugName={`rpgmaker-enemy-name-${index()}`}
                />
                <StatBar
                  current={shownHp(state(), "enemy", index())}
                  max={rpgMakerCombatantParam(db, enemy, 0)}
                  width={rect().width}
                  fill="#e85d75"
                  theme={props.theme}
                  debugName={`rpgmaker-enemy-hp-${index()}`}
                />
              </View>
              <Show when={!animationHidesTarget("enemy", index())}>
                <Show
                  when={source()}
                  fallback={(
                    <View
                      class="absolute items-center justify-center"
                      style={{
                        posType: 1,
                        insetL: rect().x,
                        insetT: rect().y,
                        width: rect().width,
                        height: rect().height,
                        bgColor: "#6a7180",
                      }}
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
                    x={rect().x}
                    y={rect().y}
                    width={rect().width}
                    height={rect().height}
                    effect={effectFor(state(), "enemy", index())}
                    nowTick={state().nowTick}
                    debugName={`rpgmaker-enemy-sprite-${index()}`}
                  />
                </Show>
              </Show>
            </Show>
          );
        }}
      </For>

      {/* Target-local flash is a deterministic source-over approximation:
          PocketJS has no portable colour-matrix primitive for tinting only
          the non-transparent battler pixels. Keep it below animation cells. */}
      <Show when={targetFlash() && animationTargetSide() === "enemy"}>
        <For each={animationTargetRects()}>
          {(target) => (
            <View
              class="absolute"
              style={{
                posType: 1,
                insetL: target.x,
                insetT: target.y,
                width: target.width,
                height: target.height,
                bgColor: targetFlash()!.color,
                opacity: targetFlash()!.opacity,
              }}
              debugName={`rpgmaker-battle-animation-target-flash-${target.side}-${target.index}`}
            />
          )}
        </For>
      </Show>

      <Show when={animationFrameSource()}>
        <For each={animationPlacements()}>
          {(placement) => (
            <LazyImage
              class="absolute"
              src={animationFrameSource()!}
              cache={imageCache}
              active={props.active}
              style={{
                posType: 1,
                insetL: 0,
                insetT: 0,
                translateX: placement.x,
                translateY: placement.y,
                width: animationAsset()!.w,
                height: animationAsset()!.h,
                scaleX: animationMarker()?.mirror === true ? -1 : 1,
              }}
              debugName={`rpgmaker-battle-animation-frame-${placement.key}`}
            />
          )}
        </For>
      </Show>

      <View
        class="absolute flex-col"
        style={{ posType: 1, insetL: 8, insetB: 8, width: actorWidth() }}
        debugName="rpgmaker-party-hud"
      >
        <For each={state().actors}>
          {(actor, index) => {
            const face = () => actorFace(actor);
            const rowStyle = () => animationHidesTarget("actor", index())
              ? { height: 30, opacity: 0 }
              : { height: 30 };
            return (
              <Show
                when={face()}
                fallback={(
                  <View
                    class="flex-col"
                    style={rowStyle()}
                    debugName={`rpgmaker-actor-hud-${index()}`}
                  >
                    <ActorHudLines actor={actor} index={index()} width={actorWidth()} />
                  </View>
                )}
              >
                <View
                  class="flex-row"
                  style={rowStyle()}
                  debugName={`rpgmaker-actor-hud-${index()}`}
                >
                  <View style={{ width: 32, height: 30 }}>
                    <Image
                      src={face()!}
                      style={{ width: 28, height: 28 }}
                      debugName={`rpgmaker-actor-face-${index()}`}
                    />
                  </View>
                  <View class="flex-col" style={{ width: actorWidth() - 32, height: 30 }}>
                    <ActorHudLines actor={actor} index={index()} width={actorWidth() - 32} />
                  </View>
                </View>
              </Show>
            );
          }}
        </For>
      </View>

      <Show when={targetFlash() && animationTargetSide() === "actor"}>
        <For each={animationTargetRects()}>
          {(target) => (
            <View
              class="absolute"
              style={{
                posType: 1,
                insetL: target.x,
                insetT: target.y,
                width: target.width,
                height: target.height,
                bgColor: targetFlash()!.color,
                opacity: targetFlash()!.opacity,
              }}
              debugName={`rpgmaker-battle-animation-target-flash-${target.side}-${target.index}`}
            />
          )}
        </For>
      </Show>

      {/* RPG Maker's spriteset-wide presentation covers battlers and the
          in-scene HUD, while command/message windows remain readable above
          it. The shared layer is absent until one sparse descriptor exists. */}
      <Show when={screenToneWeatherActive(props.screen)}>
        <ScreenToneWeatherLayer
          screen={() => props.screen}
          width={() => props.width}
          height={() => props.height}
        />
      </Show>

      <Show when={screenFlash()}>
        <View
          class="absolute"
          style={{
            posType: 1,
            insetL: 0,
            insetT: 0,
            width: props.width,
            height: props.height,
            bgColor: screenFlash()!.color,
            opacity: screenFlash()!.opacity,
          }}
          debugName="rpgmaker-battle-animation-screen-flash"
        />
      </Show>

      <Show when={state().phase === "message"}>
        <MessageBand
          lines={state().message.split("\n")}
          revealed={rpgMakerMessageRevealed(state())}
          legend={text.ok}
          width={props.width - 16}
          style={{ insetL: 8, insetB: 8 }}
          theme={props.theme}
          debugName="rpgmaker-battle-message"
        />
      </Show>
      <Show when={state().phase === "party"}>
        <ListMenu
          title={state().actors[0]?.name ?? text.party}
          rows={[
            { label: db.terms.fight },
            { label: db.terms.escape, disabled: !state().canEscape },
          ]}
          index={state().menuIndex}
          width={menuWidth()}
          style={{ insetR: 8, insetB: 8 }}
          theme={props.theme}
          debugName="rpgmaker-party-command"
        />
      </Show>
      <Show when={state().phase === "command"}>
        <CommandGrid
          cells={commandCells()}
          index={state().menuIndex}
          tick={state().nowTick}
          style={{ insetR: 8, insetB: 8 }}
          theme={props.theme}
          debugName="rpgmaker-actor-command"
        />
      </Show>
      <Show when={state().phase === "skill"}>
        <ListMenu
          title={db.terms.skill}
          rows={skills().map((skill) => ({
            label: skill.name,
            detail: skill.mpCost > 0
              ? `${db.terms.basic.mpAbbr} ${skill.mpCost}`
              : skill.tpCost > 0 ? `${db.terms.basic.tpAbbr} ${skill.tpCost}` : "",
            disabled: state().actors[state().actorIndex]!.mp < skill.mpCost ||
              state().actors[state().actorIndex]!.tp < skill.tpCost,
          }))}
          index={state().listIndex}
          description={skills()[state().listIndex]?.description}
          width={menuWidth()}
          style={{ insetR: 8, insetB: 8 }}
          theme={props.theme}
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
          theme={props.theme}
          debugName="rpgmaker-item-menu"
        />
      </Show>
      <Show when={state().phase === "target"}>
        <ListMenu
          title={text.target}
          rows={targets().indices.map((index) => ({ label: targets().battlers[index]!.name }))}
          index={Math.max(0, targets().indices.indexOf(state().targetIndex))}
          width={menuWidth()}
          style={{ insetR: 8, insetB: 8 }}
          theme={props.theme}
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
