// tests/fixtures/ui-text/fixture-data.ts — a Simplified Chinese table for
// every key of the kit's interface words (src/engine/ui-text.ts), and the
// one-map project the ui-text sim (tests/ui-text-sim.test.ts) boots with it.
// Some entries are deliberately longer than their box so the test sees them
// wrap. Every string is a literal here, so the build bakes its glyphs; fonts/
// holds the fallback face cut to exactly these characters (bun
// tools/cjk-font.ts, see fonts/NotoSansCJKsc-subset.md).

import type { GameEvent, Item, MapDef, Project } from "../../../src/engine/types.ts";
import type { UiTextTable } from "../../../src/engine/ui-text.ts";

export const MAP_ID = "ui-text-field";
export const MAP_ID_2 = "ui-text-field-2";
export const MAP_SIZE = { width: 4, height: 4 } as const;

/** Every key, in Chinese. Typed as the full table, so a key added to the
 *  kit without a translation here fails to compile. */
export const ZH_UI_TEXT: UiTextTable = {
  "legend.talk": "交谈",
  "legend.next": "下一页",
  "legend.ok": "确定",
  "legend.back": "返回",
  "shop.buy": "购买",
  "shop.sell": "出售",
  "shop.gold": "持有金币：{gold}",
  "shop.rowSell": "出售物品",
  // Wider than the shop box: wraps onto a second row.
  "shop.rowLeave": "离开商店，下次再来看看有没有新到的货物吧",
  "shop.rowBack": "返回购买",
  "shop.price": "{price}金",
  "shop.priceStock": "{price}金（剩{stock}）",
  "demo.badge": "演示 {frame}/{frames}",
  "demo.control": "现在由你来操作",
  "demo.rewind": "倒带{seconds}秒",
  "error.event": "事件出错",
  "save.title": "存档菜单",
  "save.toSlot": "存到存档位",
  "save.fromSlot": "从存档位读取",
  "save.codeExport": "导出存档码",
  "save.codeImport": "输入存档码读取",
  "save.slotsSaveTitle": "选择要存入的存档位",
  "save.slotsLoadTitle": "选择要读取的存档位",
  "save.autosave": "自动存档",
  "save.slotEmpty": "（空）",
  "save.slotDamaged": "！存档已损坏",
  "save.slotSummary": "地图 {map} · 第{frame}帧",
  "save.emptyTitle": "{slot}号存档位是空的",
  "save.emptyBody": "这里没有可以读取的存档。",
  "save.codeTitle": "存档码 第{page}/{pages}页（上下键翻页）",
  // Wider than the save panel: wraps.
  "save.codeHint": "请把这串存档码抄写下来，之后可以在“输入存档码读取”里把它重新输入进来继续游戏；按×键返回上一页。",
  "save.importTitle": "输入存档码",
  "save.importHint": "下方会打开键盘；按START确认，按×取消。",
  "save.refusedTitle": "现在无法存档",
  "save.refusedEventError": "游戏因错误而停止。",
  "save.refusedBattle": "战斗中无法存档。",
  "save.refusedConversation": "请先结束对话。",
  "save.refusedMapChange": "请等待地图切换完成。",
  "save.refusedScene": "请等待场景结束。",
  "save.refusedWalking": "请先停下脚步。",
  "save.snapshotFailed": "无法保存游戏状态。",
  "save.failedTitle": "存档失败",
  "save.failedBody": "无法写入存档。",
  "save.savedTitle": "已保存至{slot}号存档位",
  "save.savedBody": "{map}（{x},{y}）",
  "save.loadingTitle": "正在读取",
  "save.loadingBody": "正在准备{map}……",
  "save.loadSlotFailedTitle": "无法读取{slot}号存档位",
  "save.loadCodeFailedTitle": "无法读取这个存档码",
  "save.loadAutosaveFailedTitle": "无法读取自动存档",
  "save.loadErrorContent": "这个存档来自游戏的另一个构建版本。",
  "save.loadErrorChecksum": "这个存档已损坏（校验和不匹配）。",
  "save.loadErrorVersion": "这个存档来自更新的版本。",
  "save.loadErrorInvalid": "这不是Pocket Tuxemon存档。",
  "save.loadErrorShape": "这个存档不适用于本游戏。",
  "save.loadErrorRead": "无法读取存档。",
  "save.loadedSlotToast": "已读取{slot}号存档位",
  "save.loadedCodeToast": "已读取存档码",
  "save.loadedAutosaveToast": "已读取自动存档",
  // Wider than the name panel: wraps and pushes the grid down.
  "nameInput.title": "请输入主角的名字（最多八个字符），这个名字会出现在之后所有的对话里",
  "nameInput.back": "删",
  "nameInput.ok": "确定",
  "nameInput.cancel": "取消",
  "nameInput.random": "随机",
  "demo.menuTitle": "演示控制",
  "demo.tabChapters": "章节",
  "demo.tabWarp": "地图跳转",
  "demo.tabAutoplay": "自动演示",
  "demo.tabSelected": "【{tab}】",
  "demo.empty": "还没有配置任何条目。",
  "demo.speed": "速度 {speed}倍",
  "demo.speedHint": "A：切换",
  // Wider than the demo menu: wraps and grows the panel.
  "demo.legend": "左右键：翻页　上下键：选择　A键：确认　B键：关闭菜单并回到游戏继续游玩",
  "demo.legendBack": "A/B：返回",
  "demo.loading": "正在载入地图",
  "demo.warped": "已跳转——剧情状态可能与这张地图不符",
  "demo.error": "演示出错",
  "demo.badLink": "演示链接有误",
  "demo.errorUnknownChapter": "未知章节：{id}",
  "demo.errorUnknownMap": "未知地图：{id}",
  "demo.errorUnknownAutoplay": "未知自动演示章节：{id}",
  "demo.errorXY": "x 和 y 必须同时提供。",
  "demo.badLinkChooseOne": "章节、地图或自动演示只能选一个。",
  "demo.badLinkSpeed": "速度需要自动演示；x 和 y 需要地图。",
  "battle.statValue": "{current}／{max}",
};

/** A partial table: the rest of the keys keep their English defaults. */
export const PARTIAL_UI_TEXT: Partial<UiTextTable> = {
  "shop.buy": "购买",
  "shop.gold": "持有金币：{gold}",
};

export const ITEMS: Item[] = [
  { id: "potion", name: "伤药", sprite: "plain.0", price: 30 },
  { id: "ball", name: "捕捉球", sprite: "plain.0", price: 200 },
];

/** What the fixture's autorun page does on map entry. */
export type Scenario = "shop" | "name" | "name-random" | "idle" | "error";

function autorun(scenario: Scenario): GameEvent["pages"][number]["commands"] {
  switch (scenario) {
    case "shop":
      return [
        { op: "text", lines: ["欢迎光临！"] },
        { op: "gold", set: "add", amount: 500 },
        { op: "item", item: "potion", set: "add", count: 2 },
        { op: "shop", id: "ui-text-shop", goods: [{ item: "potion" }, { item: "ball", stock: 3 }] },
      ];
    case "name":
      return [{ op: "scene", id: "rpgkit.nameInput", args: { maxLength: 8 } as never }];
    case "name-random":
      // A candidate list makes the RANDOM action cell appear after CANCEL.
      return [{
        op: "scene",
        id: "rpgkit.nameInput",
        args: { maxLength: 8, randomNames: ["上上下下左右左右BA"] } as never,
      }];
    case "error":
      return [{ op: "transfer", map: "nowhere", x: 1, y: 1 }];
    case "idle":
      return [];
  }
}

export function fixtureProject(scenario: Scenario, uiText: Partial<UiTextTable> | undefined): Project {
  const map: MapDef = {
    id: MAP_ID,
    name: MAP_ID,
    width: MAP_SIZE.width,
    height: MAP_SIZE.height,
    sheets: ["plain"],
    ground: new Array(MAP_SIZE.width * MAP_SIZE.height).fill("plain.0"),
    events: [
      {
        id: "ui-text-run",
        x: 1,
        y: 1,
        pages: [
          { trigger: "autorun", commands: [...autorun(scenario), { op: "switch", id: "ui-text-done", value: true }] },
          { condition: { switch: "ui-text-done" }, trigger: "action", commands: [] },
        ],
      },
    ],
  };
  const map2: MapDef = {
    id: MAP_ID_2,
    name: MAP_ID_2,
    width: MAP_SIZE.width,
    height: MAP_SIZE.height,
    sheets: ["plain"],
    ground: new Array(MAP_SIZE.width * MAP_SIZE.height).fill("plain.0"),
    events: [],
  };
  return {
    format: "rpgkit-project/v1",
    title: "ui text fixture",
    tileSize: 16,
    start: { map: MAP_ID, x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: ITEMS,
    ...(uiText ? { uiText } : {}),
    maps: [map, map2],
  };
}

/** The save code the overlay's export page shows: two pages of it. */
export const SAVE_CODE = "A".repeat(240) + "B".repeat(60);
