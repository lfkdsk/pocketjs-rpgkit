import type { CjkMultiStrings } from "./app.tsx";

export const JAPANESE_STRINGS: CjkMultiStrings = {
  locale: "ja-JP",
  legend: "決定　戻る",
  // 骨・令・返・曜 have visibly different regional outlines in the pinned
  // SC, TC and JP faces; the visual test compares their baked bitmap cells.
  dialog: [
    "「骨・令・返・曜」は日本語の字形です。",
    "きょうは海辺の店へ行き、ゲーム表示を確認します。",
  ],
  choicePrompt: "どの道を選びますか？",
  choices: ["町へ戻る", "海辺の店へ行く", "令和の道を進む"],
  itemNames: { medicine: "回復薬", map: "冒険の地図" },
  shopText: {
    "shop.buy": "購入",
    "shop.sell": "売却",
    "shop.gold": "所持金：{gold}",
    "shop.rowSell": "持ち物を売る",
    "shop.rowLeave": "店を出る",
    "shop.rowBack": "購入へ戻る",
    "shop.price": "{price}G",
    "shop.priceStock": "{price}G（残り{stock}）",
  },
  battleTitle: "技を選ぶ",
  battleDescription: "相手の弱点をねらいます。",
  battleRows: ["骨砕き", "海の息吹", "曜日の光"],
  battleCommands: ["たたかう", "どうぐ", "交代", "逃げる"],
  battleMessage: "野生の骨竜が現れた！",
  saveTitle: "冒険をセーブ",
  saveMap: "海辺の町",
  saveText: {
    "save.title": "冒険をセーブ",
    "save.toSlot": "スロットに保存",
    "save.fromSlot": "スロットから読込",
    "save.codeExport": "セーブコードを書出",
    "save.codeImport": "セーブコードを読込",
  },
};
