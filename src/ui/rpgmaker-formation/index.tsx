// Optional RPG Maker party-formation overlay. This module is reached only by
// games that explicitly pass its config to GameView's overlay prop.

import { createMemo, createSignal, Show } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { deepClone } from "../../engine/clone.ts";
import type { SessionState } from "../../engine/session.ts";
import { reconcileFollowers } from "../../engine/travel.ts";
import type {
  GameViewDemoRuntime,
  GameViewDemoStepResult,
  GameViewOverlayConfig,
  GameViewSessionHost,
} from "../demo-contract.ts";
import { ListMenu, type ListMenuRow } from "../battle/ListMenu.tsx";
import { resolveUiTheme, type UiTheme } from "../theme.ts";

export interface RpgMakerFormationOptions {
  /** Raw PocketJS button mask. Defaults to the map cancel button (CROSS). */
  openButton?: number;
}

interface FormationMember {
  actorId: number;
  name: string;
}

interface FormationViewProps {
  open: () => boolean;
  members: () => readonly FormationMember[];
  cursor: () => number;
  first: () => number | null;
  theme?: Partial<UiTheme>;
}

function partyOrder(host: GameViewSessionHost): number[] {
  const state = host.getState();
  const world = host.session.worlds.get(state.mapId);
  const text = world?.rpgMakerText;
  if (!world || !text) return [];
  return text.runtime.partyOrder({
    variables: state.interp.sw.variables,
    switches: state.interp.sw.switches,
    ...(state.interp.sw.partyOrder ? { partyOrder: state.interp.sw.partyOrder } : {}),
    actorIds: [...(world.actors?.keys() ?? [])],
  }, text);
}

function FormationView(props: FormationViewProps) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const rows = createMemo((): readonly ListMenuRow[] => props.members().map((member, index) => ({
    label: member.name,
    detail: [index === 0 ? "Leader" : "", props.first() === index ? "First" : ""]
      .filter(Boolean)
      .join(" / "),
  })));

  return (
    <Show when={props.open()}>
      <View
        class="absolute inset-0 flex-row justify-center items-center"
        style={{ posType: 1, bgColor: theme().backdrop }}
        debugName="rpgmaker-formation-overlay"
      >
        <ListMenu
          title="Formation"
          description="Choose two party members to swap. Walking sprite art stays fixed."
          rows={rows()}
          index={props.cursor()}
          visibleRows={8}
          width={260}
          theme={props.theme}
          debugName="rpgmaker-formation"
        />
      </View>
    </Show>
  );
}

function partyMembers(host: GameViewSessionHost): FormationMember[] {
  const state = host.getState();
  const world = host.session.worlds.get(state.mapId);
  if (!world) return [];
  const names = new Map(
    (host.project.actors ?? []).flatMap((actor) =>
      actor.databaseId === undefined ? [] : [[actor.databaseId, actor.name] as const]),
  );
  return partyOrder(host).map((actorId) => ({
    actorId,
    name: names.get(actorId) ?? `Actor ${actorId}`,
  }));
}

function canOpenFormation(state: Readonly<SessionState>): boolean {
  return state.interp.modal === null && state.scene === null &&
    state.interp.sw.menuAccess !== false && state.interp.sw.formationAccess !== false;
}

function makeRuntime(
  host: GameViewSessionHost,
  options: RpgMakerFormationOptions,
): GameViewDemoRuntime {
  const openButton = options.openButton ?? BTN.CROSS;
  const [open, setOpen] = createSignal(false);
  const [members, setMembers] = createSignal<readonly FormationMember[]>([]);
  const [cursor, setCursor] = createSignal(0);
  const [first, setFirst] = createSignal<number | null>(null);

  const refresh = (): void => {
    const next = partyMembers(host);
    setMembers(next);
    setCursor((index) => Math.max(0, Math.min(index, next.length - 1)));
  };
  const close = (): void => {
    setOpen(false);
    setFirst(null);
  };
  const move = (delta: number): void => {
    const count = members().length;
    if (count > 0) setCursor((index) => (index + delta + count) % count);
  };
  const choose = (): GameViewDemoStepResult => {
    const selected = cursor();
    if (!members()[selected]) return { consumed: true };
    const picked = first();
    if (picked === null) {
      setFirst(selected);
      return { consumed: true };
    }
    setFirst(null);
    if (picked === selected) return { consumed: true };

    const current = host.getState();
    const world = host.session.worlds.get(current.mapId);
    if (!world) return { consumed: true };
    const order = partyOrder(host);
    if (picked >= order.length || selected >= order.length) return { consumed: true };
    [order[picked], order[selected]] = [order[selected]!, order[picked]!];

    // SessionState is JSON-safe reducer data. Clone the whole state so this
    // host action never mutates the currently presented frame, then restore
    // the reducer's required switch-bank alias explicitly.
    const next = deepClone(current) as SessionState;
    next.interp.sw.partyOrder = order;
    next.sw = next.interp.sw;
    if (next.travel && host.session.travelProject?.followers) {
      next.travel = reconcileFollowers(
        next.travel,
        host.session.travelProject.followers,
        next.sw.switches,
        next.move,
        order,
      );
    }
    // The player walking sprite is a fixed GameView resource, so an index-0
    // swap changes battle order and the follower chain but not that artwork.
    host.replaceState(next, host.heldButtons());
    refresh();
    return { consumed: true, stateChanged: true };
  };

  return {
    step(_buttons, pressed) {
      const state = host.getState();
      if (!open()) {
        if ((pressed & openButton) === 0 || !canOpenFormation(state)) return { consumed: false };
        refresh();
        if (members().length < 2) return { consumed: false };
        setCursor(0);
        setFirst(null);
        setOpen(true);
        return { consumed: true };
      }

      if (!canOpenFormation(state)) {
        close();
        return { consumed: false };
      }
      if ((pressed & openButton) !== 0 || (pressed & BTN.CROSS) !== 0) {
        close();
        return { consumed: true };
      }
      if ((pressed & BTN.UP) !== 0) move(-1);
      else if ((pressed & BTN.DOWN) !== 0) move(1);
      else if ((pressed & BTN.CIRCLE) !== 0) return choose();
      return { consumed: true };
    },
    isOpen: open,
    render(theme?: Partial<UiTheme>) {
      return <FormationView open={open} members={members} cursor={cursor} first={first} theme={theme} />;
    },
  };
}

/** Build an isolated opt-in overlay; the base GameView never imports it. */
export function createRpgMakerFormation(
  options: RpgMakerFormationOptions = {},
): GameViewOverlayConfig {
  const button = options.openButton ?? BTN.CROSS;
  if (!Number.isInteger(button) || button <= 0 || (button & (button - 1)) !== 0) {
    throw new Error("RPG Maker formation openButton must be one button bit");
  }
  if ((button & (BTN.UP | BTN.DOWN | BTN.CIRCLE)) !== 0) {
    throw new Error("RPG Maker formation openButton conflicts with menu navigation");
  }
  return { create: (host) => makeRuntime(host, options) };
}
