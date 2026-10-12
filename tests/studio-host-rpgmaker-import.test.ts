// RPG Maker import at Studio's shared host boundary: a tokenized progress
// stream, reviewable exact coverage, explicit open-result second step,
// cooperative cancellation and complete English/Chinese UI dictionaries.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StudioApp } from "../editor/studio/app.ts";
import { ArtRegistry } from "../editor/studio/art.ts";
import { StudioFiles } from "../editor/studio/files.ts";
import type { RpgMakerImportOutcome, RpgMakerImportProgress } from "../editor/studio/host.ts";
import { MemoryHost } from "../editor/studio/host-memory.ts";
import {
  RPG_MAKER_IMPORT_TEXT,
  rpgMakerImportLocale,
  rpgMakerImportText,
} from "../editor/studio/import-i18n.ts";

const ROOT = join(import.meta.dir, "..");
const SUNSTONE = readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8");

const COUNTS = { Native: 28, Degraded: 3, Placeholder: 2, Dropped: 1, total: 34 } as const;

function success(token: string): RpgMakerImportOutcome {
  return {
    ok: true,
    token,
    opened: {
      text: SUNSTONE,
      label: "Lantern (imported)",
      fileName: "lantern.rpgpack.json",
      notes: ["Browser import omitted audio conversion."],
    },
    coverage: {
      totals: { ...COUNTS },
      rows: [
        {
          section: "command",
          key: "355",
          counts: { Native: 0, Degraded: 0, Placeholder: 2, Dropped: 0 },
          reasons: ["script not ported"],
        },
        {
          section: "command",
          key: "261",
          counts: { Native: 0, Degraded: 0, Placeholder: 0, Dropped: 1 },
          reasons: ["video playback is unavailable"],
        },
      ],
    },
    warnings: ["Audio conversion is unavailable in this browser."],
  };
}

function studio(): { host: MemoryHost; app: StudioApp; files: StudioFiles } {
  const host = new MemoryHost();
  const app = new StudioApp();
  return { host, app, files: new StudioFiles(app, new ArtRegistry(), host) };
}

describe("Studio RPG Maker import host flow", () => {
  test("keeps the current document until coverage is reviewed and Open result is explicit", async () => {
    const { host, app, files } = studio();
    files.openText(SUNSTONE, "current.json", "current.json");
    app.run("paint-cells", { map: "village", layer: "ground", cells: [[1, 1]], value: "town.37" });
    const edited = app.session!.exportText();
    const progress: RpgMakerImportProgress[] = [];
    host.rpgMakerImportReply = async (request, emit) => {
      emit({ token: "stale-run", phase: "reading", message: "must be ignored" });
      emit({ token: request.token, phase: "reading", message: "data/Map001.json", completed: 1, total: 3 });
      emit({ token: request.token, phase: "packing", completed: 3, total: 3 });
      return success(request.token);
    };

    const discardMessage = rpgMakerImportText("zh").discardChanges;
    const outcome = await files.importRpgMaker("visible", (event) => progress.push(event), discardMessage);
    expect(outcome?.ok).toBe(true);
    expect(host.rpgMakerImportRequests).toEqual([{ token: "studio-rpgmaker-1", placeholders: "visible" }]);
    expect(progress.map(({ token, phase }) => ({ token, phase }))).toEqual([
      { token: "studio-rpgmaker-1", phase: "reading" },
      { token: "studio-rpgmaker-1", phase: "packing" },
    ]);
    const expected = success("studio-rpgmaker-1") as Extract<RpgMakerImportOutcome, { ok: true }>;
    expect(outcome && outcome.ok ? outcome.coverage : null).toEqual(expected.coverage);

    // The import succeeded, but the edited document is still open while the
    // user reads coverage. Discard was asked exactly once before conversion.
    expect(app.origin?.label).toBe("current.json");
    expect(app.session!.exportText()).toBe(edited);
    expect(app.session!.isDirty()).toBe(true);
    expect(host.questions).toEqual([discardMessage]);

    expect(outcome && files.openRpgMakerResult(outcome)).toBe(true);
    expect(app.origin).toEqual({ label: "Lantern (imported)", savesTo: "storage" });
    expect(files.fileName).toBe("lantern.rpgpack.json");
    expect(app.session!.isDirty()).toBe(false);
    expect(host.questions).toHaveLength(1); // no redundant prompt on Open result
    expect(app.notices.at(-1)?.text).toBe("Browser import omitted audio conversion.");
  });

  test("cancellation invalidates the token and ignores late progress and success", async () => {
    const { host, app, files } = studio();
    files.openText(SUNSTONE, "current.json", "current.json");
    const before = app.session!.exportText();
    let finish!: (outcome: RpgMakerImportOutcome) => void;
    let report!: (progress: RpgMakerImportProgress) => void;
    host.rpgMakerImportReply = (request, emit) => {
      report = emit;
      emit({ token: request.token, phase: "reading" });
      return new Promise((resolve) => { finish = resolve; });
    };
    const seen: RpgMakerImportProgress[] = [];
    const pending = files.importRpgMaker("silent", (event) => seen.push(event));
    await Bun.sleep(0);
    const token = host.rpgMakerImportRequests[0]!.token;
    await files.cancelRpgMakerImport();
    report({ token, phase: "complete", message: "late" });
    finish(success(token));

    expect(await pending).toEqual({ ok: false, token, code: "CANCELLED", message: "RPG Maker import cancelled." });
    expect(host.rpgMakerImportCancels).toEqual([token]);
    expect(seen.map((event) => event.phase)).toEqual(["reading"]);
    expect(app.origin?.label).toBe("current.json");
    expect(app.session!.exportText()).toBe(before);
  });

  test("turns a thrown host failure into a readable import outcome", async () => {
    const { host, files } = studio();
    host.rpgMakerImportReply = async () => {
      throw new Error("data/System.json is missing");
    };
    const outcome = await files.importRpgMaker("visible", () => {});
    expect(outcome).toEqual({
      ok: false,
      token: "studio-rpgmaker-1",
      code: "IMPORT_FAILED",
      message: "The host could not import this RPG Maker project: data/System.json is missing",
    });
  });
});

describe("RPG Maker import i18n", () => {
  test("English and Chinese dictionaries have the same complete key and phase sets", () => {
    const en = RPG_MAKER_IMPORT_TEXT.en;
    const zh = RPG_MAKER_IMPORT_TEXT.zh;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zh.phase).sort()).toEqual(Object.keys(en.phase).sort());
    expect(Object.values(en).filter((value) => typeof value === "string").every((value) => value.length > 0)).toBe(true);
    expect(Object.values(zh).filter((value) => typeof value === "string").every((value) => value.length > 0)).toBe(true);
    expect(en.Placeholder).toBe("Placeholder");
    expect(en.Dropped).toBe("Dropped");
    expect(zh.limitations).toContain("占位");
    expect(zh.limitations).toContain("丢弃");
    expect(zh.openResult).toBe("打开结果");
  });

  test("resolves Chinese language tags and otherwise falls back to English", () => {
    expect(rpgMakerImportLocale(["zh-Hans-CN", "en-US"])).toBe("zh");
    expect(rpgMakerImportLocale("zh-TW")).toBe("zh");
    expect(rpgMakerImportLocale(["en-US", "zh-CN"])).toBe("en");
    expect(rpgMakerImportLocale(["ja-JP", "en-US"])).toBe("en");
    expect(rpgMakerImportLocale(undefined)).toBe("en");
    expect(rpgMakerImportText("en").chooseSource).toBe("Choose source folder…");
    expect(rpgMakerImportText("zh").chooseSource).toBe("选择源文件夹…");
  });
});
