// editor/studio/import-i18n.ts — the small bilingual surface for the RPG
// Maker import journey. Importer-authored construct names and reasons remain
// verbatim technical data; every control, state and summary label is local.

import type { RpgMakerImportPhase } from "./host.ts";

export type RpgMakerImportLocale = "en" | "zh";

export interface RpgMakerImportText {
  menu: string;
  title: string;
  language: string;
  intro: string;
  destination: string;
  discardChanges: string;
  placeholderMode: string;
  visiblePlaceholders: string;
  visiblePlaceholdersHint: string;
  silentPlaceholders: string;
  silentPlaceholdersHint: string;
  chooseSource: string;
  cancel: string;
  close: string;
  retry: string;
  openResult: string;
  importing: string;
  ready: string;
  failure: string;
  cancelled: string;
  coverage: string;
  coverageHint: string;
  uses: string;
  limitations: string;
  limitationHint: string;
  noLimitations: string;
  reasons: string;
  warnings: string;
  Native: string;
  Degraded: string;
  Placeholder: string;
  Dropped: string;
  phase: Record<RpgMakerImportPhase, string>;
}

export const RPG_MAKER_IMPORT_TEXT: Record<RpgMakerImportLocale, RpgMakerImportText> = {
  en: {
    menu: "Import RPG Maker MV/MZ…",
    title: "Import RPG Maker MV/MZ",
    language: "Language",
    intro: "Choose an RPG Maker MV or MZ source folder. Studio converts its maps, events, database and available media, then lets you review coverage before opening the result.",
    destination: "In the desktop app, you may also be asked for a destination. It creates a new <source>-rpgkit folder and never overwrites an existing folder.",
    discardChanges: "The open document has unsaved changes. Discard them before importing?",
    placeholderMode: "Unsupported scripts and plugins",
    visiblePlaceholders: "Show visible placeholders",
    visiblePlaceholdersHint: "Recommended: the imported game visibly names behavior that still needs a port.",
    silentPlaceholders: "Keep placeholders silent",
    silentPlaceholdersHint: "Omit placeholder text in play, while retaining it in coverage.",
    chooseSource: "Choose source folder…",
    cancel: "Cancel",
    close: "Close",
    retry: "Try again",
    openResult: "Open result",
    importing: "Importing project",
    ready: "Import complete. Review the coverage before opening the result.",
    failure: "Import failed",
    cancelled: "Import cancelled.",
    coverage: "Coverage summary",
    coverageHint: "Command uses are classified by how faithfully they were converted.",
    uses: "uses",
    limitations: "Placeholder and Dropped reasons",
    limitationHint: "These source constructs need attention. Counts and reasons come directly from the importer.",
    noLimitations: "No Placeholder or Dropped command uses were reported.",
    reasons: "Reasons",
    warnings: "Warnings",
    Native: "Native",
    Degraded: "Degraded",
    Placeholder: "Placeholder",
    Dropped: "Dropped",
    phase: {
      selecting: "Choose source folder",
      reading: "Read source files",
      converting: "Convert project",
      packing: "Pack browser project",
      writing: "Publish imported files",
      complete: "Complete",
    },
  },
  zh: {
    menu: "导入 RPG Maker MV/MZ…",
    title: "导入 RPG Maker MV/MZ",
    language: "语言",
    intro: "选择一个 RPG Maker MV 或 MZ 源项目文件夹。Studio 会转换地图、事件、数据库和可用媒体；打开结果前，你可以先检查覆盖率。",
    destination: "桌面版可能还会要求选择目标位置。它会新建 <源项目>-rpgkit 文件夹，绝不会覆盖已有文件夹。",
    discardChanges: "当前文档有未保存的更改。要放弃这些更改并开始导入吗？",
    placeholderMode: "不支持的脚本和插件",
    visiblePlaceholders: "显示可见占位",
    visiblePlaceholdersHint: "推荐：导入后的游戏会明确标出仍需移植的行为。",
    silentPlaceholders: "静默保留占位",
    silentPlaceholdersHint: "游玩时不显示占位文字，但仍计入覆盖率。",
    chooseSource: "选择源文件夹…",
    cancel: "取消",
    close: "关闭",
    retry: "重试",
    openResult: "打开结果",
    importing: "正在导入项目",
    ready: "导入完成。请先检查覆盖率，再打开结果。",
    failure: "导入失败",
    cancelled: "导入已取消。",
    coverage: "覆盖率摘要",
    coverageHint: "命令用量按转换后的语义保真度分类。",
    uses: "次",
    limitations: "Placeholder（占位）与 Dropped（丢弃）原因",
    limitationHint: "以下源构造需要处理；计数和原因直接来自导入器。",
    noLimitations: "没有报告 Placeholder（占位）或 Dropped（丢弃）命令。",
    reasons: "原因",
    warnings: "警告",
    Native: "原生",
    Degraded: "降级",
    Placeholder: "占位",
    Dropped: "丢弃",
    phase: {
      selecting: "选择源文件夹",
      reading: "读取源文件",
      converting: "转换项目",
      packing: "打包浏览器项目",
      writing: "发布导入文件",
      complete: "完成",
    },
  },
};

/** Resolve browser/OS language tags with a deliberate English fallback. */
export function rpgMakerImportLocale(languages: string | readonly string[] | null | undefined): RpgMakerImportLocale {
  const values = typeof languages === "string" ? [languages] : languages ?? [];
  for (const language of values) {
    const tag = language.toLowerCase();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

export function rpgMakerImportText(locale: RpgMakerImportLocale): RpgMakerImportText {
  return RPG_MAKER_IMPORT_TEXT[locale];
}
