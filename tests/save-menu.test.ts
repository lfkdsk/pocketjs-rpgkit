// tests/rpgkit-save-menu.test.ts — P1⑤ save menu navigation fold.
//
// The reducer decides pages and returns a side-effect command for CONFIRM;
// the host performs fs/OSK work. Covers root navigation on both fs and
// code-only targets, slot wrap-around, empty-slot refusal, export paging
// and message dismissal.

import { describe, expect, test } from "bun:test";
import {
  exportPage,
  menuStep,
  saveMenuRootRows,
  slotInRange,
  type ExtraRootRow,
  type MenuState,
} from "../src/engine/save-menu.ts";

const FS_CTX = { hasFs: true, slotNonEmpty: [true, false, true] as readonly boolean[], codePages: 2 };
const CODE_CTX = { hasFs: false, slotNonEmpty: [false, false, false] as readonly boolean[], codePages: 1 };
const AUTO_CTX = { ...FS_CTX, autosaveAvailable: true };
const WEB_AUTO_CTX = { ...CODE_CTX, autosaveAvailable: true };

describe("P1⑤ save menu — root", () => {
  test("fs target lists four rows; down/up wrap and confirm enters pages", () => {
    let s: MenuState = { kind: "root", index: 0 };
    s = menuStep(s, "down", FS_CTX).state;
    expect(s).toEqual({ kind: "root", index: 1 });
    s = menuStep(s, "down", FS_CTX).state;
    expect(s).toEqual({ kind: "root", index: 2 });
    // confirm on "Save code (export)" opens export and issues the command
    const opened = menuStep(s, "confirm", FS_CTX);
    expect(opened.state).toEqual({ kind: "code-export", page: 0 });
    expect(opened.command).toEqual({ op: "open-export" });
    // wrap from last to first
    let last: MenuState = { kind: "root", index: 3 };
    last = menuStep(last, "down", FS_CTX).state;
    expect(last).toEqual({ kind: "root", index: 0 });
    // back closes the menu
    expect(menuStep({ kind: "root", index: 0 }, "back", FS_CTX).state).toEqual({ kind: "closed" });
  });

  test("code-only target lists two rows; import row returns open-import", () => {
    let s: MenuState = menuStep({ kind: "root", index: 0 }, "down", CODE_CTX).state;
    expect(s).toEqual({ kind: "root", index: 1 });
    const opened = menuStep(s, "confirm", CODE_CTX);
    expect(opened.state).toEqual({ kind: "code-import" });
    expect(opened.command).toEqual({ op: "open-import" });
    // wrap stays within the two rows
    expect(menuStep({ kind: "root", index: 1 }, "down", CODE_CTX).state).toEqual({ kind: "root", index: 0 });
  });

  test("a web target with an autosave exposes a load row without manual slots", () => {
    expect(menuStep({ kind: "root", index: 0 }, "confirm", WEB_AUTO_CTX).state)
      .toEqual({ kind: "slots-load", index: 0 });
    expect(menuStep({ kind: "slots-load", index: 0 }, "confirm", WEB_AUTO_CTX).command)
      .toEqual({ op: "load-autosave" });
    expect(menuStep({ kind: "slots-load", index: 0 }, "up", WEB_AUTO_CTX).state)
      .toEqual({ kind: "slots-load", index: 0 });
    expect(menuStep({ kind: "slots-load", index: 0 }, "back", WEB_AUTO_CTX).state)
      .toEqual({ kind: "root", index: 0 });
    expect(menuStep({ kind: "code-export", page: 0 }, "back", WEB_AUTO_CTX).state)
      .toEqual({ kind: "root", index: 1 });
    expect(menuStep({ kind: "code-import" }, "back", WEB_AUTO_CTX).state)
      .toEqual({ kind: "root", index: 2 });
  });

  test("closed state ignores all actions", () => {
    for (const a of ["up", "down", "confirm", "back"] as const) {
      expect(menuStep({ kind: "closed" }, a, FS_CTX)).toEqual({ state: { kind: "closed" } });
    }
  });
});

describe("P1⑤ save menu — slots", () => {
  test("save confirm issues save-slot for slot 1..3; back returns to root", () => {
    const r1 = menuStep({ kind: "slots-save", index: 0 }, "confirm", FS_CTX);
    expect(r1.command).toEqual({ op: "save-slot", slot: 1 });
    const r3 = menuStep({ kind: "slots-save", index: 2 }, "confirm", FS_CTX);
    expect(r3.command).toEqual({ op: "save-slot", slot: 3 });
    expect(menuStep({ kind: "slots-save", index: 2 }, "back", FS_CTX).state).toEqual({ kind: "root", index: 0 });
  });

  test("load confirm issues load-slot only for a non-empty slot", () => {
    // slot 1 has data
    expect(menuStep({ kind: "slots-load", index: 0 }, "confirm", FS_CTX).command).toEqual({ op: "load-slot", slot: 1 });
    // slot 2 is empty: a message page, no command
    const empty = menuStep({ kind: "slots-load", index: 1 }, "confirm", FS_CTX);
    expect(empty.command).toBeUndefined();
    expect(empty.state.kind).toBe("message");
    // dismissing the message returns to the slot list
    expect(menuStep(empty.state, "confirm", FS_CTX).state).toEqual({ kind: "slots-load", index: 1 });
    // back returns to the root load row
    expect(menuStep({ kind: "slots-load", index: 0 }, "back", FS_CTX).state).toEqual({ kind: "root", index: 1 });
  });

  test("slot cursor wraps over three rows", () => {
    expect(menuStep({ kind: "slots-save", index: 2 }, "down", FS_CTX).state).toEqual({ kind: "slots-save", index: 0 });
    expect(menuStep({ kind: "slots-load", index: 0 }, "up", FS_CTX).state).toEqual({ kind: "slots-load", index: 2 });
  });

  test("a reported autosave is the first load row and cannot become a save target", () => {
    expect(menuStep({ kind: "slots-load", index: 0 }, "confirm", AUTO_CTX)).toEqual({
      state: { kind: "slots-load", index: 0 },
      command: { op: "load-autosave" },
    });
    expect(menuStep({ kind: "slots-load", index: 0 }, "up", AUTO_CTX).state)
      .toEqual({ kind: "slots-load", index: 3 });
    expect(menuStep({ kind: "slots-load", index: 1 }, "confirm", AUTO_CTX).command)
      .toEqual({ op: "load-slot", slot: 1 });
    expect(menuStep({ kind: "slots-save", index: 0 }, "confirm", AUTO_CTX).command)
      .toEqual({ op: "save-slot", slot: 1 });
  });
});

describe("P1⑤ save menu — code pages", () => {
  test("up/down page the export clamped to range; confirm/back return to root", () => {
    expect(menuStep({ kind: "code-export", page: 0 }, "down", FS_CTX).state).toEqual({ kind: "code-export", page: 1 });
    // clamped at the last page
    expect(menuStep({ kind: "code-export", page: 1 }, "down", FS_CTX).state).toEqual({ kind: "code-export", page: 1 });
    expect(menuStep({ kind: "code-export", page: 0 }, "up", FS_CTX).state).toEqual({ kind: "code-export", page: 0 });
    // return lands on the export root row (2 with fs, 0 without)
    expect(menuStep({ kind: "code-export", page: 1 }, "confirm", FS_CTX).state).toEqual({ kind: "root", index: 2 });
    expect(menuStep({ kind: "code-export", page: 0 }, "back", CODE_CTX).state).toEqual({ kind: "root", index: 0 });
  });

  test("exportPage helper clamps", () => {
    expect(exportPage(0, 3, 1)).toBe(1);
    expect(exportPage(2, 3, 1)).toBe(2);
    expect(exportPage(0, 1, -1)).toBe(0);
  });

  test("import back returns to the import root row", () => {
    expect(menuStep({ kind: "code-import" }, "back", FS_CTX).state).toEqual({ kind: "root", index: 3 });
    expect(menuStep({ kind: "code-import" }, "back", CODE_CTX).state).toEqual({ kind: "root", index: 1 });
  });
});

describe("P1⑤ save menu — slot validation", () => {
  test("slotInRange accepts only integers 1..3", () => {
    expect(slotInRange(1)).toBe(true);
    expect(slotInRange(3)).toBe(true);
    expect(slotInRange(0)).toBe(false);
    expect(slotInRange(4)).toBe(false);
    expect(slotInRange(1.5)).toBe(false);
  });
});

describe("P1⑤ save menu — extra root rows", () => {
  const EXTRA: readonly ExtraRootRow[] = [
    { id: "tuxepedia", label: "Tuxepedia" },
    { id: "journal", label: "Journal" },
  ];
  const FS_EXTRA_CTX = { ...FS_CTX, extra: EXTRA };

  test("saveMenuRootRows appends extra rows after the kit rows", () => {
    const rows = saveMenuRootRows(true, false, EXTRA);
    expect(rows.map((r) => r.id)).toEqual([
      "slots-save",
      "slots-load",
      "code-export",
      "code-import",
      "tuxepedia",
      "journal",
    ]);
    // Extra rows carry their label and no ui-text key.
    expect(rows[4]!.label).toBe("Tuxepedia");
    expect(rows[4]!.textKey).toBeUndefined();
    // Without extra rows the list is unchanged.
    expect(saveMenuRootRows(true, false, [])).toHaveLength(4);
  });

  test("root navigation wraps over the combined rows", () => {
    // 4 kit rows + 2 extra = 6 rows
    let s: MenuState = { kind: "root", index: 5 };
    s = menuStep(s, "down", FS_EXTRA_CTX).state;
    expect(s).toEqual({ kind: "root", index: 0 });
    s = menuStep(s, "up", FS_EXTRA_CTX).state;
    expect(s).toEqual({ kind: "root", index: 5 });
  });

  test("confirm on an extra row returns the extra command and stays on root", () => {
    const r = menuStep({ kind: "root", index: 4 }, "confirm", FS_EXTRA_CTX);
    expect(r.state).toEqual({ kind: "root", index: 4 });
    expect(r.command).toEqual({ op: "extra", id: "tuxepedia" });
    const r2 = menuStep({ kind: "root", index: 5 }, "confirm", FS_EXTRA_CTX);
    expect(r2.command).toEqual({ op: "extra", id: "journal" });
  });

  test("confirm on a kit row still enters its page with extra rows present", () => {
    const r = menuStep({ kind: "root", index: 0 }, "confirm", FS_EXTRA_CTX);
    expect(r.state).toEqual({ kind: "slots-save", index: 0 });
    expect(r.command).toBeUndefined();
    // back from a sub-page still lands on the kit row's index
    expect(menuStep({ kind: "slots-save", index: 0 }, "back", FS_EXTRA_CTX).state)
      .toEqual({ kind: "root", index: 0 });
  });

  test("back on root still closes the menu", () => {
    expect(menuStep({ kind: "root", index: 4 }, "back", FS_EXTRA_CTX).state)
      .toEqual({ kind: "closed" });
  });

  test("a code-only target appends extra rows after its two rows", () => {
    const rows = saveMenuRootRows(false, false, EXTRA);
    expect(rows.map((r) => r.id)).toEqual(["code-export", "code-import", "tuxepedia", "journal"]);
    const r = menuStep({ kind: "root", index: 2 }, "confirm", { ...CODE_CTX, extra: EXTRA });
    expect(r.command).toEqual({ op: "extra", id: "tuxepedia" });
  });
});
