import type { CjkMultiStrings } from "./app.tsx";

export const TRADITIONAL_CHINESE_STRINGS: CjkMultiStrings = {
  locale: "zh-Hant-TW",
  legend: "確定　返回",
  dialog: [
    "「骨、令、返、曜」使用臺灣繁體字形。",
    "歡迎來到海邊商店，請確認遊戲選單與對話。",
  ],
  choicePrompt: "你要選擇哪一條道路？",
  choices: ["返回城鎮", "前往海邊商店", "沿著冒險道路前進"],
  itemNames: { medicine: "恢復藥", map: "冒險地圖" },
  shopText: {
    "shop.buy": "購買",
    "shop.sell": "出售",
    "shop.gold": "持有金幣：{gold}",
    "shop.rowSell": "出售物品",
    "shop.rowLeave": "離開商店",
    "shop.rowBack": "返回購買",
    "shop.price": "{price}金",
    "shop.priceStock": "{price}金（剩餘{stock}）",
  },
  battleTitle: "選擇招式",
  battleDescription: "瞄準對手的弱點。",
  battleRows: ["碎骨重擊", "海洋吐息", "曜日之光"],
  battleCommands: ["戰鬥", "道具", "交換", "逃跑"],
  battleMessage: "野生骨龍出現了！",
  saveTitle: "儲存冒險進度",
  saveMap: "海邊城鎮",
  saveText: {
    "save.title": "儲存冒險進度",
    "save.toSlot": "儲存到欄位",
    "save.fromSlot": "從欄位讀取",
    "save.codeExport": "匯出存檔碼",
    "save.codeImport": "輸入存檔碼讀取",
  },
};
