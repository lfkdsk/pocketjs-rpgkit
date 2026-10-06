// Full-screen editor playtest presentation. GameView is the production
// renderer/reducer host; the surrounding chrome is editor-only and observes
// its state through a temporary global descriptor installed by this component.

import { createMemo, createSignal, For, onCleanup } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { SessionState } from "../../src/engine/session.ts";
import type { JsonValue, Project } from "../../src/engine/types.ts";
import { GameView, type BattleSceneViewProps, type SceneComponent } from "../../src/ui/GameView.tsx";
import { ChoiceIconBox } from "../../src/ui/ChoiceIconBox.tsx";
import { ItemIconRow } from "../../src/ui/ItemIconRow.tsx";
import { ParallaxLayer } from "../../src/ui/ParallaxLayer.tsx";
import { krm2ScreenPresentation } from "../../src/ui/krm2/index.ts";
import type { GameAssets } from "../../src/ui/game-assets.ts";
import {
  applyPlaytestCarry,
  editPlaytestState,
  playtestDebugRows,
  type PlaytestCarry,
  type PlaytestDebugEdit,
  type PlaytestIssue,
} from "../engine/playtest.ts";
import {
  PLAYTEST_BAR_H,
  PLAYTEST_TABS,
  playtestDebugRect,
  playtestPanelRect,
  playtestRowRect,
  playtestRowsPerPage,
  playtestStopRect,
  playtestTabRects,
  type PlaytestTab,
} from "../engine/playtest-layout.ts";
import { PLAYTEST_BATTLE_RULES, playtestSceneRules } from "../engine/playtest-view.ts";
import { playtestSceneIds } from "../engine/playtest.ts";
import { ACCENT, BUTTON, BUTTON_ON, DIM, INK, PANEL } from "./panels.tsx";
import { fitEditorText } from "./text-fit.ts";

interface RuntimeGlobal {
  __rpgSessionState?: SessionState;
}

export interface PlaytestPort {
  state(): SessionState | null;
  edit(change: PlaytestDebugEdit): boolean;
}

export interface PlaytestSurfaceProps {
  project: Project;
  assets: GameAssets;
  carry: PlaytestCarry | null;
  width: number;
  height: number;
  debugOpen: boolean;
  tab: PlaytestTab;
  page: number;
  issues: readonly PlaytestIssue[];
  onState: (state: SessionState | null) => void;
  onPort: (port: PlaytestPort | null) => void;
}

function EditorBattleScene(props: BattleSceneViewProps): JSX.Element {
  const setup = () => {
    const state = props.state as { setup?: JsonValue };
    return fitEditorText(JSON.stringify(state.setup ?? null), Math.max(0, props.width - 16));
  };
  return (
    <View
      class="absolute flex-col items-center justify-center"
      style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height, bgColor: "#171126" }}
      debugName="editor-playtest-battle-placeholder"
    >
      <Text class="text-lg" style={{ textColor: ACCENT, lineHeight: 22, height: 22 }}>BATTLE PREVIEW</Text>
      <Text class="text-xs" style={{ width: Math.max(0, props.width - 16), textAlign: 1, textColor: INK, lineHeight: 14, height: 14 }}>{setup()}</Text>
      <Text class="text-xs" style={{ width: Math.max(0, props.width - 16), textAlign: 1, textColor: DIM, lineHeight: 14, height: 14 }}>{fitEditorText("CIRCLE: WIN   CROSS: ESCAPE", Math.max(0, props.width - 16))}</Text>
    </View>
  );
}

/** Builds the visible placeholder for one unregistered scene id. The id is
 *  closed over (the SceneRules state carries only the opaque args), so the
 *  preview says which scene it stands in for. */
function makeEditorScenePlaceholder(id: string): SceneComponent {
  return function EditorScenePlaceholder(props: BattleSceneViewProps): JSX.Element {
    const textWidth = () => Math.max(0, props.width - 16);
    const args = () => {
      const state = props.state as { args?: JsonValue };
      return fitEditorText(JSON.stringify(state.args ?? null), textWidth());
    };
    return (
      <View
        class="absolute flex-col items-center justify-center"
        style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height, bgColor: "#171126" }}
        debugName={`editor-playtest-scene-placeholder-${id}`}
      >
        <Text class="text-lg" style={{ textColor: ACCENT, lineHeight: 22, height: 22 }}>SCENE PREVIEW</Text>
        <Text class="text-xs" style={{ width: textWidth(), textAlign: 1, textColor: INK, lineHeight: 14, height: 14 }}>{fitEditorText(id, textWidth())}</Text>
        <Text class="text-xs" style={{ width: textWidth(), textAlign: 1, textColor: INK, lineHeight: 14, height: 14 }}>{args()}</Text>
        <Text class="text-xs" style={{ width: textWidth(), textAlign: 1, textColor: DIM, lineHeight: 14, height: 14 }}>{fitEditorText("CIRCLE: OK   CROSS: CANCEL", textWidth())}</Text>
      </View>
    );
  };
}

/** One placeholder view per scene id the document references, keyed the same
 *  way GameView's sceneViews dispatch expects. */
function playtestSceneViews(project: Project): Record<string, SceneComponent> {
  return Object.fromEntries(playtestSceneIds(project).map((id) => [id, makeEditorScenePlaceholder(id)]));
}

function valueText(value: boolean | number | string | undefined): string {
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  if (value === undefined) return "-";
  return String(value);
}

export function PlaytestSurface(props: PlaytestSurfaceProps): JSX.Element {
  const runtimeGlobal = globalThis as RuntimeGlobal;
  const previous = Object.getOwnPropertyDescriptor(runtimeGlobal, "__rpgSessionState");
  let state: SessionState | null = null;
  const [liveState, setLiveState] = createSignal<SessionState | null>(null);
  let initial = true;

  Object.defineProperty(runtimeGlobal, "__rpgSessionState", {
    configurable: true,
    get: () => state ?? undefined,
    set: (incoming: SessionState | undefined) => {
      if (!incoming) {
        state = null;
        props.onState(null);
        return;
      }
      if (initial) {
        initial = false;
        const carried = applyPlaytestCarry(incoming, props.carry);
        if (carried !== incoming) Object.assign(incoming, carried);
      }
      state = incoming;
      setLiveState(incoming);
      props.onState(incoming);
    },
  });

  const port: PlaytestPort = {
    state: () => state,
    edit(change) {
      if (!state) return false;
      const changed = editPlaytestState(state, change);
      Object.assign(state, changed);
      setLiveState({ ...state });
      props.onState({ ...state });
      return true;
    },
  };
  props.onPort(port);
  const currentState = liveState;

  onCleanup(() => {
    props.onPort(null);
    props.onState(null);
    if (previous) Object.defineProperty(runtimeGlobal, "__rpgSessionState", previous);
    else delete runtimeGlobal.__rpgSessionState;
  });

  const warning = () => props.issues.length > 0;
  const panel = createMemo(() => playtestPanelRect(props.width, props.height, warning()));
  const rows = createMemo(() => {
    const current = liveState();
    return current ? playtestDebugRows(props.project, current, props.tab) : [];
  });
  const rowsPerPage = createMemo(() => playtestRowsPerPage(panel()));
  const pageCount = createMemo(() => Math.max(1, Math.ceil(rows().length / rowsPerPage())));
  const currentPage = createMemo(() => Math.max(0, Math.min(pageCount() - 1, props.page)));
  const visibleRows = createMemo(() => rows().slice(
    currentPage() * rowsPerPage(),
    (currentPage() + 1) * rowsPerPage(),
  ));

  return (
    <View class="w-full h-full overflow-hidden bg-black" debugName="editor-playtest-root">
      <GameView
        project={props.project}
        assets={props.assets}
        screenPresentation={krm2ScreenPresentation}
        extensions={{ allowUnknown: true }}
        battle={PLAYTEST_BATTLE_RULES}
        battleScene={EditorBattleScene}
        choiceIcons={ChoiceIconBox}
        itemIcons={ItemIconRow}
        parallax={ParallaxLayer}
        scenes={playtestSceneRules(props.project)}
        sceneViews={playtestSceneViews(props.project)}
        // The editor app owns the host pointer lines (debug panel hit
        // testing through connectSvc); GameView must not drain them.
        tapToWalk={false}
      />

      <View
        class="absolute"
        style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: PLAYTEST_BAR_H, bgColor: "#10131b", opacity: 0.94, zIndex: 900 }}
        debugName="editor-playtest-bar"
      >
        <View class="absolute flex-row items-center justify-center" style={{ posType: 1, insetL: playtestStopRect().x, insetT: playtestStopRect().y, width: playtestStopRect().w, height: playtestStopRect().h, bgColor: "#8f3040" }} debugName="editor-playtest-stop">
          <Text class="text-xs" style={{ textColor: "#ffffff", lineHeight: 12, height: 12 }}>STOP</Text>
        </View>
        <View class="absolute flex-row items-center justify-center" style={{ posType: 1, insetL: playtestDebugRect().x, insetT: playtestDebugRect().y, width: playtestDebugRect().w, height: playtestDebugRect().h, bgColor: props.debugOpen ? BUTTON_ON : BUTTON, borderWidth: props.debugOpen ? 1 : 0, borderColor: ACCENT }} debugName="editor-playtest-debug-toggle">
          <Text class="text-xs" style={{ textColor: INK, lineHeight: 12, height: 12 }}>DEBUG</Text>
        </View>
        <Text class="absolute text-xs" style={{ posType: 1, insetL: 118, insetT: 4, width: Math.max(0, props.width - 122), textColor: ACCENT, lineHeight: 12, height: 12 }}>
          {fitEditorText(`PLAY ${currentState()?.mapId ?? props.project.start.map} · START/ESC STOP · SELECT DEBUG`, Math.max(0, props.width - 122))}
        </Text>
      </View>

      {warning() ? (
        <View class="absolute" style={{ posType: 1, insetL: 0, insetT: PLAYTEST_BAR_H, width: props.width, height: 20, bgColor: "#5b3b13", opacity: 0.96, zIndex: 901 }} debugName="editor-playtest-warning">
          <Text class="text-xs" style={{ insetL: 5, insetT: 3, width: props.width - 10, textColor: "#ffe092", lineHeight: 12, height: 12 }}>
            {fitEditorText(props.issues[0]!.message, Math.max(0, props.width - 10))}
          </Text>
        </View>
      ) : null}

      {props.debugOpen ? (
        <View
          class="absolute"
          style={{ posType: 1, insetL: panel().x, insetT: panel().y, width: panel().w, height: panel().h, bgColor: PANEL, opacity: 0.96, borderWidth: 1, borderColor: ACCENT, zIndex: 902 }}
          debugName="editor-playtest-debug-panel"
        >
          <Text class="absolute text-xs" style={{ posType: 1, insetL: 5, insetT: 4, width: panel().w - 10, textColor: ACCENT, lineHeight: 12, height: 12 }}>
            {fitEditorText(`LIVE STATE · F${currentState()?.frame ?? 0}`, Math.max(0, panel().w - 10))}
          </Text>
          <For each={playtestTabRects(panel())}>
            {(entry) => (
              <View class="absolute flex-row items-center justify-center" style={{ posType: 1, insetL: entry.rect.x - panel().x, insetT: entry.rect.y - panel().y, width: entry.rect.w, height: entry.rect.h, bgColor: entry.tab === props.tab ? BUTTON_ON : BUTTON }} debugName={`editor-playtest-tab-${entry.tab}`}>
                <Text class="text-xs" style={{ textColor: entry.tab === props.tab ? ACCENT : DIM, lineHeight: 10, height: 10 }}>
                  {entry.tab === "variable" ? "VAR" : entry.tab === "switch" ? "SW" : entry.tab.toUpperCase()}
                </Text>
              </View>
            )}
          </For>
          <For each={visibleRows()}>
            {(row, index) => {
              const rect = () => playtestRowRect(panel(), index());
              return (
                <View class="absolute" style={{ posType: 1, insetL: rect().x - panel().x, insetT: rect().y - panel().y, width: rect().w, height: rect().h, bgColor: index() % 2 ? "#202a3b" : "#17202e" }} debugName={`editor-playtest-row-${row.kind}-${row.label}`}>
                  <Text class="absolute text-xs" style={{ posType: 1, insetL: 4, insetT: 3, width: Math.max(0, rect().w - 74), textColor: INK, lineHeight: 11, height: 11 }}>{fitEditorText(row.label, Math.max(0, rect().w - 74))}</Text>
                  {row.kind !== "run" ? <Text class="absolute text-xs" style={{ posType: 1, insetL: rect().w - 66, insetT: 3, width: 10, textColor: DIM, lineHeight: 11, height: 11 }}>-</Text> : null}
                  <Text class="absolute text-xs" style={{ posType: 1, insetL: rect().w - 52, insetT: 3, width: row.kind === "run" ? 50 : 32, textColor: row.kind === "switch" && row.value ? "#5fd38a" : ACCENT, lineHeight: 11, height: 11 }}>
                    {fitEditorText(valueText(row.value), row.kind === "run" ? 50 : 32)}
                  </Text>
                  {row.kind !== "run" ? <Text class="absolute text-xs" style={{ posType: 1, insetL: rect().w - 14, insetT: 3, width: 10, textColor: DIM, lineHeight: 11, height: 11 }}>+</Text> : null}
                </View>
              );
            }}
          </For>
          <Text class="absolute text-xs" style={{ posType: 1, insetL: 5, insetT: panel().h - 12, width: 42, textColor: DIM, lineHeight: 10, height: 10 }}>PREV</Text>
          <Text class="absolute text-xs" style={{ posType: 1, insetL: panel().w - 45, insetT: panel().h - 12, width: 40, textColor: DIM, lineHeight: 10, height: 10 }}>NEXT</Text>
          <Text class="absolute text-xs" style={{ posType: 1, insetL: Math.floor(panel().w / 2) - 22, insetT: panel().h - 12, width: 44, textColor: DIM, lineHeight: 10, height: 10 }}>
            {`${currentPage() + 1}/${pageCount()}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
