// One UI gallery shared by the Japanese and Traditional Chinese language
// apps in this example. Each entry imports only its own strings and carries
// only its own regional subset font; switching language selects another app
// bundle before mount instead of putting two Han shapes in one font atlas.

import { Show, batch, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework";
import { View } from "@pocketjs/framework/components";
import { createOsk } from "@pocketjs/framework/osk";
import type { Modal } from "../../src/engine/interpreter.ts";
import type { MenuState } from "../../src/engine/save-menu.ts";
import type { UiTextOverrides } from "../../src/engine/ui-text.ts";
import { scalarLength } from "../../src/engine/text-break.ts";
import { CommandGrid } from "../../src/ui/battle/CommandGrid.tsx";
import { ListMenu } from "../../src/ui/battle/ListMenu.tsx";
import { MessageBand } from "../../src/ui/battle/MessageBand.tsx";
import { DialogBox } from "../../src/ui/DialogBox.tsx";
import { SaveMenu, type SlotInfo } from "../../src/ui/SaveMenu.tsx";

export type CjkMultiPage = "dialog" | "choices" | "shop" | "battle" | "save";

export interface CjkMultiStrings {
  readonly locale: string;
  readonly legend: string;
  readonly dialog: readonly string[];
  readonly choicePrompt: string;
  readonly choices: readonly [string, string, string];
  readonly itemNames: Readonly<Record<"medicine" | "map", string>>;
  readonly shopText: UiTextOverrides;
  readonly battleTitle: string;
  readonly battleDescription: string;
  readonly battleRows: readonly [string, string, string];
  readonly battleCommands: readonly [string, string, string, string];
  readonly battleMessage: string;
  readonly saveTitle: string;
  readonly saveMap: string;
  readonly saveText: UiTextOverrides;
}

declare global {
  // Test and screenshot driver. A real app would call the same switch from
  // its menu or route; keeping it explicit makes every gallery page stable.
  // eslint-disable-next-line no-var
  var __cjkMulti: { show(page: CjkMultiPage): void; locale: string } | undefined;
}

function textModal(lines: readonly string[]): Modal {
  const total = scalarLength(lines.join("\n"));
  return { kind: "text", fiber: "cjk-multi", lines: [...lines], total, revealed: total, complete: true };
}

function Fixture(props: { strings: CjkMultiStrings }) {
  const s = props.strings;
  const [page, setPage] = createSignal<CjkMultiPage>("dialog");
  const [menu, setMenu] = createSignal<MenuState>({ kind: "closed" });
  const [code, setCode] = createSignal("");
  const osk = createOsk({ value: code, setValue: setCode, onCommit: () => {} });
  const slots: SlotInfo = [{ slot: 1, map: s.saveMap, frame: 120, checksum: "cjk-multi" }, null, null];

  globalThis.__cjkMulti = {
    locale: s.locale,
    show(next) {
      batch(() => {
        setPage(next);
        setMenu(next === "save" ? { kind: "root", index: 0 } : { kind: "closed" });
      });
    },
  };

  const modal = (): Modal | null => {
    switch (page()) {
      case "dialog":
        return textModal(s.dialog);
      case "choices":
        return {
          kind: "choices",
          fiber: "cjk-multi",
          prompt: s.choicePrompt,
          options: [...s.choices],
          index: 1,
          cancellable: true,
        };
      case "shop":
        return {
          kind: "shop",
          fiber: "cjk-multi",
          gold: 888,
          sell: true,
          stage: "buy",
          index: 0,
          rows: [
            { kind: "item", item: "medicine", price: 30, owned: 2, canAfford: true, atCap: false, stock: 5, sellable: true },
            { kind: "item", item: "map", price: 120, owned: 0, canAfford: true, atCap: false, stock: 1, sellable: true },
            { kind: "sell" },
            { kind: "leave" },
          ],
        };
      default:
        return null;
    }
  };

  return (
    <View class="w-full h-full overflow-hidden bg-black">
      <Show when={page() === "battle"}>
        <ListMenu
          rows={s.battleRows.map((label, index) => ({ label, detail: `${index + 2} MP` }))}
          index={0}
          title={s.battleTitle}
          description={s.battleDescription}
          visibleRows={3}
          width={210}
          style={{ insetL: 8, insetT: 8 }}
          debugName="cjk-multi-battle-list"
        />
        <CommandGrid
          cells={s.battleCommands.map((label) => ({ label })) as unknown as [
            { label: string }, { label: string }, { label: string }, { label: string },
          ]}
          index={0}
          tick={0}
          style={{ insetR: 8, insetT: 8 }}
          debugName="cjk-multi-battle-grid"
        />
        <MessageBand
          lines={[s.battleMessage]}
          legend={s.legend}
          width={464}
          style={{ insetL: 8, insetB: 8 }}
          debugName="cjk-multi-battle-message"
        />
      </Show>
      <SaveMenu
        menu={menu}
        hasFs={true}
        slots={() => slots}
        autosave={() => null}
        saveCode={code}
        osk={osk}
        legend={() => s.legend}
        title={s.saveTitle}
        uiText={s.saveText}
      />
      <DialogBox
        modal={modal}
        legend={() => s.legend}
        viewportWidth={480}
        items={{ medicine: { name: s.itemNames.medicine }, map: { name: s.itemNames.map } }}
        uiText={s.shopText}
      />
    </View>
  );
}

export function mountCjkMulti(strings: CjkMultiStrings): void {
  mount(() => <Fixture strings={strings} />);
}
