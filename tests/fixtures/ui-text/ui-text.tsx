// tests/fixtures/ui-text/ui-text.tsx — sim fixture for the kit's interface
// words (tests/ui-text-sim.test.ts). The real GameView runs a one-map
// project whose `uiText` replaces the kit's words (fixture-data.ts); the
// scenario the test names before boot picks what opens:
//
// - shop / name / error: the map's autorun page opens a message then a
//   shop, the built-in name input, or a transfer to a missing map (the
//   event-error screen);
// - demo / demo-empty: a GameView demo with an attract tape (the badge,
//   takeover and rewind notices, the demo menu on SELECT);
// - every scenario: START opens a save-menu overlay (SaveMenu driven by
//   menuStep) with a StatBar readout under it, both handed the uiText
//   GameView passes to overlays.
//
// fonts.json beside this entry bakes the Chinese glyphs from fonts/.

import { createMemo, createSignal, type Accessor } from "solid-js";
import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { createOsk } from "@pocketjs/framework/osk";
import { GameView } from "../../../src/ui/GameView.tsx";
import { NameInputScene } from "../../../src/ui/name-input/NameInputScene.tsx";
import { SaveMenu, type SlotInfo } from "../../../src/ui/SaveMenu.tsx";
import { StatBar } from "../../../src/ui/battle/StatBar.tsx";
import { BoundedLine } from "../../../src/ui/BoundedLine.tsx";
import { fitBounded } from "../../../src/ui/list-window.ts";
import { slotMeasure } from "../../../src/ui/text-measure.ts";
import { useMarqueeTick } from "../../../src/ui/use-marquee-tick.ts";
import { createDemo } from "../../../src/ui/demo/index.ts";
import { NAME_INPUT_SCENE_ID, nameInputRules } from "../../../src/engine/name-input.ts";
import { SAVE_MENU_UI_TEXT, menuStep, type MenuAction, type MenuState, type SaveMenuTextKey } from "../../../src/engine/save-menu.ts";
import { createSession, startSession } from "../../../src/engine/session.ts";
import { createSessionSnapshot } from "../../../src/engine/save.ts";
import { createJsonMapRepository } from "../../../src/engine/map-repository.ts";
import { splitProjectMaps } from "../../../tools/lib/map-project.ts";
import { formatUiText, type UiTextOverrides, type UiTextTable } from "../../../src/engine/ui-text.ts";
import type { GameViewOverlayConfig } from "../../../src/ui/demo-contract.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { fixtureProject, MAP_ID, MAP_ID_2, PARTIAL_UI_TEXT, SAVE_CODE, ZH_UI_TEXT, type Scenario } from "./fixture-data.ts";

type FixtureScenario = Scenario | "demo" | "demo-empty";

declare global {
  // eslint-disable-next-line no-var
  var __uiTextScenario: FixtureScenario | undefined;
  /** Which table the project carries: the full Chinese one (default), a
   *  partial one, or none. */
  // eslint-disable-next-line no-var
  var __uiTextTable: "zh" | "partial" | "none" | undefined;
  /** Optional GameView `uiText` prop, layered over the project's table. */
  // eslint-disable-next-line no-var
  var __uiTextProp: Partial<UiTextTable> | undefined;
  /** Swap the GameView `uiText` prop at run time (the B2 runtime-switch
   *  test): the next frame draws the new words. */
  // eslint-disable-next-line no-var
  var __uiTextSetProp: ((table: Partial<UiTextTable> | undefined) => void) | undefined;
  /** Put one save-runtime string on the real SaveMenu message page. The
   *  schema-max test uses this after replacing that key with its marker. */
  // eslint-disable-next-line no-var
  var __uiTextShowSaveMessage: ((key: SaveMenuTextKey) => void) | undefined;
}

const scenario: FixtureScenario = globalThis.__uiTextScenario ?? "idle";
const tableName = globalThis.__uiTextTable ?? "zh";
const propText = globalThis.__uiTextProp;
const table = tableName === "zh" ? ZH_UI_TEXT : tableName === "partial" ? PARTIAL_UI_TEXT : undefined;
const demoMode = scenario === "demo" || scenario === "demo-empty";
const project = fixtureProject(demoMode ? "idle" : scenario, table);

// The demo scenarios run a sharded project with an async map source: a warp
// to a not-yet-prepared map enters the demo menu's busy state, which draws
// `demo.loading` (the only path that shows it). The start map is prepared
// up front so createSession and the attract tape boot normally.
const demoShard = demoMode
  ? (() => {
      const split = splitProjectMaps(project);
      const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
      const startEntry = split.shell.mapIndex.find((meta) => meta.id === split.shell.start.map)!.entry;
      const prepared = new Set<string>([startEntry]);
      const repository = createJsonMapRepository(split.shell.mapIndex, {
        read: (entry: string) => (prepared.has(entry) ? files.get(entry) : undefined),
        prepare: (entry: string) => {
          prepared.add(entry);
          return Promise.resolve();
        },
      });
      return { shell: split.shell, repository };
    })()
  : null;

// A run-time switch of GameView's `uiText` prop (the B2 test flips this):
// the accessor reads the signal, so the next frame draws the new words.
const [propOverride, setPropOverride] = createSignal<Partial<UiTextTable> | undefined>(undefined);
globalThis.__uiTextSetProp = (next) => setPropOverride(() => next);

const SLOTS: SlotInfo = [null, { slot: 2, error: "checksum" }, { slot: 3, map: MAP_ID, frame: 4321 } as SlotInfo[number]];

/** The fixture's ordinary in-world action hint. Games own this placement;
 *  it uses the kit's bounded cell so even a schema-maximum replacement is
 *  reachable without leaving the viewport. */
function TalkLegend(props: { text: string }) {
  const width = 464;
  const cell = createMemo(() => fitBounded(`○ ${props.text}`, width, 1, slotMeasure()));
  const tick = useMarqueeTick(createMemo(() => cell().kind === "marquee"));
  return (
    <View class="absolute" style={{ posType: 1, insetL: 8, insetB: 2, width, height: 14 }}>
      <BoundedLine
        cell={cell()}
        tick={tick}
        textColor="#c8d4f0"
        rowH={14}
        width={width}
        debugName="ui-text-talk-legend"
      />
    </View>
  );
}

/** A save menu overlay opened by START, wired like a game would: menuStep
 *  for navigation, SaveMenu to draw, both given GameView's uiText. */
const saveOverlay: GameViewOverlayConfig = {
  create() {
    const [menu, setMenu] = createSignal<MenuState>({ kind: "closed" });
    const [code, setCode] = createSignal("");
    const osk = createOsk({ value: code, setValue: setCode, onCommit: () => {} });
    let text: UiTextOverrides | undefined;
    globalThis.__uiTextShowSaveMessage = (key) => {
      const template = text?.[key] ?? SAVE_MENU_UI_TEXT[key];
      const value = formatUiText(template, { slot: 3, map: MAP_ID, x: 2, y: 2 });
      const inTitle = key.endsWith("Title");
      setMenu({
        kind: "message",
        title: inTitle ? value : "MESSAGE",
        body: inTitle ? "Message body." : value,
        back: { kind: "closed" },
      });
    };
    const fold = (action: MenuAction): void => {
      const next = menuStep(menu(), action, {
        hasFs: true,
        slotNonEmpty: SLOTS.map((slot) => slot !== null),
        autosaveAvailable: true,
        codePages: 2,
        text,
      });
      setMenu(next.state);
    };
    return {
      isOpen: () => menu().kind !== "closed",
      step(_buttons, pressed) {
        if (menu().kind === "closed") {
          if (pressed & BTN.START) {
            setMenu({ kind: "root", index: 0 });
            return { consumed: true };
          }
          return { consumed: false };
        }
        if (pressed & BTN.UP) fold("up");
        else if (pressed & BTN.DOWN) fold("down");
        else if (pressed & BTN.CIRCLE) fold("confirm");
        else if (pressed & BTN.CROSS) fold("back");
        return { consumed: true };
      },
      render(theme, uiText) {
        text = uiText;
        return (
          <>
            <SaveMenu
              menu={menu}
              hasFs
              slots={() => SLOTS}
              autosave={() => ({ slot: 0, map: MAP_ID_2, frame: 7654, checksum: "auto" })}
              saveCode={() => SAVE_CODE}
              osk={osk}
              legend={() => "o x"}
              theme={theme}
              uiText={uiText}
            />
            <View
              class="absolute"
              style={{ posType: 1, insetL: 8, insetT: 4, display: menu().kind === "closed" ? 1 : 0 }}
              debugName="ui-text-statbar"
            >
              <StatBar current={37} max={120} width={60} showNumbers numbersWidth={80} uiText={uiText} />
            </View>
            {/* The talk legend: GameView hands the merged table to an
                overlay, which draws it like a game's footer would. */}
            <View style={{ display: menu().kind === "closed" ? 0 : 1 }}>
              <TalkLegend text={uiText?.["legend.talk"] ?? "talk"} />
            </View>
          </>
        );
      },
    };
  },
};

function demoConfig() {
  if (!demoMode) return {};
  const demoProject = demoShard ? demoShard.shell : project;
  const session = demoShard
    ? createSession(demoProject, 60, { maps: demoShard.repository })
    : createSession(demoProject, 60);
  const snapshot = createSessionSnapshot(session, startSession(demoProject, session), 0);
  const tape = new Array<number>(600).fill(0);
  const chapters = scenario === "demo"
    ? [{ id: "first", title: "第一章", snapshot, tape }]
    : [];
  return { attractTape: tape, demo: createDemo({ chapters }) };
}

const textProp: Accessor<UiTextOverrides | undefined> = () => propOverride() ?? propText;

mount(() => (
  <GameView
    project={demoShard ? demoShard.shell : project}
    maps={demoShard ? demoShard.repository : undefined}
    assets={GAME_ASSETS}
    scenes={{ [NAME_INPUT_SCENE_ID]: nameInputRules }}
    sceneViews={{ [NAME_INPUT_SCENE_ID]: NameInputScene }}
    overlay={saveOverlay}
    uiText={textProp()}
    {...demoConfig()}
  />
));
