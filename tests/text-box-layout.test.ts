// tests/text-box-layout.test.ts — the text command's optional layout
// (position, align, valign, background): the geometry DialogBox and the
// paginator share (ui/dialog-pages.ts), the interpreter's sparse `box` on
// the compiled instruction and the open text modal, the paginator seeing
// the layout, the schema accepting exactly the documented values, and the
// snapshot checks of a saved instruction's `box`. The pixels are checked in
// tests/text-layout-sim.test.ts.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compile, createInterpState, textBoxLayout, type Instr, type TextModal } from "../src/engine/interpreter.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { createSnapshot } from "../src/engine/save.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { createSession, startSession, stepSession, type SessionState } from "../src/engine/session.ts";
import type { Command, Project, TextBoxLayout } from "../src/engine/types.ts";
import schema from "../src/data/schema.json";
import {
  createDialogPaginator,
  dialogAlignShift,
  dialogBoxBottom,
  dialogBoxHeight,
  dialogBoxInsets,
  dialogBoxRows,
  dialogColumnWidth,
  dialogFaceSize,
  dialogTextAreaHeight,
  dialogValignShift,
  messagePageStarts,
} from "../src/ui/dialog-pages.ts";
import { flowRows } from "../src/ui/text-flow.ts";
import { scalarLength } from "../src/engine/text-break.ts";
import { translucentColor } from "../src/ui/theme.ts";
import { createFontMeasure } from "../tools/lib/font-measure.ts";

const measure = createFontMeasure({ px: 12, fallbacks: [join(import.meta.dir, "fixtures", "cjk-text", "fonts", "NotoSansCJKsc-subset.otf")] });

const POSITIONS = ["top", "center", "bottom", "topLeft", "topRight", "bottomLeft", "bottomRight", "left", "right"] as const;

describe("box geometry", () => {
  // Tuxemon's small dialog window (ui/dialogue.py, large_gui off): 0.8 of
  // the screen wide and 0.25 high, flush against the edges it is anchored
  // to. The bands keep the RPG Maker box: full width less 8 px a side.
  test("the bands span the screen, corners and sides are four fifths wide and flush", () => {
    for (const width of [480, 960]) {
      const narrow = Math.floor((width * 4) / 5);
      for (const position of [undefined, "top", "center", "bottom"] as const) {
        expect(dialogBoxInsets(width, position)).toEqual({ left: 8, right: 8 });
      }
      for (const position of ["topLeft", "bottomLeft", "left"] as const) {
        expect(dialogBoxInsets(width, position)).toEqual({ left: 0, right: width - narrow });
      }
      for (const position of ["topRight", "bottomRight", "right"] as const) {
        expect(dialogBoxInsets(width, position)).toEqual({ left: width - narrow, right: 0 });
      }
    }
    // 480: the corner box spans x 0..384, the right one 96..480; 960:
    // 0..768 and 192..960.
    expect(dialogBoxInsets(480, "bottomLeft")).toEqual({ left: 0, right: 96 });
    expect(dialogBoxInsets(960, "topRight")).toEqual({ left: 192, right: 0 });
  });

  test("corner and side boxes are a quarter of the screen high, the bands 92 px", () => {
    for (const height of [272, 544]) {
      for (const position of [undefined, "top", "center", "bottom"] as const) {
        expect(dialogBoxHeight(position, height)).toBe(92);
        expect(dialogBoxRows(position, height)).toBe(4);
      }
    }
    for (const position of ["topLeft", "topRight", "bottomLeft", "bottomRight", "left", "right"] as const) {
      // 480x272 -> 384x68: two rows above the legend; 960x544 -> 768x136.
      expect(dialogBoxHeight(position, 272)).toBe(68);
      expect(dialogBoxRows(position, 272)).toBe(2);
      expect(dialogBoxHeight(position, 544)).toBe(136);
      expect(dialogBoxRows(position, 544)).toBe(6);
    }
  });

  test("bands dock 8 px from the bottom or top edge, corners touch it, the rest sit centred", () => {
    for (const height of [272, 544]) {
      for (const position of [undefined, "bottom"] as const) {
        expect(dialogBoxBottom(position, height, 92)).toBe(8);
      }
      for (const position of ["bottomLeft", "bottomRight"] as const) {
        expect(dialogBoxBottom(position, height, 68)).toBe(0);
      }
      // Box top at y = 8 for the band, y = 0 for a corner.
      expect(height - dialogBoxBottom("top", height, 92) - 92).toBe(8);
      for (const position of ["topLeft", "topRight"] as const) {
        expect(height - dialogBoxBottom(position, height, 68) - 68).toBe(0);
      }
      // A name tab asks the top band for more room above; a corner window
      // stays against the top edge (its tab hangs below it).
      expect(height - dialogBoxBottom("top", height, 92, 16) - 92).toBe(16);
      for (const position of ["topLeft", "topRight"] as const) {
        expect(height - dialogBoxBottom(position, height, 68, 16) - 68).toBe(0);
      }
      for (const position of ["center", "left", "right", "bottom", "bottomLeft", "bottomRight", undefined] as const) {
        const box = dialogBoxHeight(position, height);
        expect(dialogBoxBottom(position, height, box, 16)).toBe(dialogBoxBottom(position, height, box));
      }
      for (const position of ["center", "left", "right"] as const) {
        const box = dialogBoxHeight(position, height);
        const bottom = dialogBoxBottom(position, height, box);
        const top = height - bottom - box;
        expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("the text column narrows with the box and the portrait", () => {
    const layout = { viewportWidth: 480, faces: { KEEPER: "face.png" } };
    // Default: 480 - 36 px of chrome, unchanged by passing no position.
    expect(dialogColumnWidth({ viewportWidth: 480 }, false)).toBe(444);
    for (const position of ["top", "center", "bottom"] as const) {
      expect(dialogColumnWidth({ viewportWidth: 480 }, false, position)).toBe(444);
    }
    for (const position of ["topLeft", "topRight", "bottomLeft", "bottomRight", "left", "right"] as const) {
      // 384 px box less the 2 px frame and 8 px padding a side.
      expect(dialogColumnWidth({ viewportWidth: 480 }, false, position)).toBe(384 - 20);
      // The portrait shrinks to the 48 px inner height, its 72 px column
      // with it (54 px); at 960x544 the 64 px image fits at 1x.
      expect(dialogColumnWidth(layout, true, position)).toBe(384 - 20 - 54);
      expect(dialogColumnWidth({ ...layout, viewportHeight: 272 }, true, position)).toBe(384 - 20 - 54);
      expect(dialogColumnWidth({ ...layout, viewportWidth: 960, viewportHeight: 544 }, true, position)).toBe(768 - 20 - 72);
      expect(dialogColumnWidth({ viewportWidth: 960 }, false, position)).toBe(768 - 20);
    }
    for (const position of [undefined, "top", "center", "bottom"] as const) {
      // The bands keep the 64 px portrait and its 72 px column.
      expect(dialogColumnWidth(layout, true, position)).toBe(480 - 36 - 72);
      expect(dialogColumnWidth({ ...layout, viewportWidth: 960, viewportHeight: 544 }, true, position)).toBe(960 - 36 - 72);
    }
    // A narrower portrait column scales with the image.
    expect(dialogColumnWidth({ ...layout, faceWidth: 64 }, true, "left")).toBe(384 - 20 - 48);
  });

  test("the portrait fills the window's inner height: whole multiples of 64 px, smaller when 64 px does not fit", () => {
    for (const position of [undefined, "top", "center", "bottom"] as const) {
      for (const height of [240, 272, 544, 816, 1088]) expect(dialogFaceSize(position, height)).toBe(64);
    }
    for (const position of ["topLeft", "topRight", "bottomLeft", "bottomRight", "left", "right"] as const) {
      expect(dialogFaceSize(position, 272)).toBe(48); // 68 - 20
      expect(dialogFaceSize(position, 240)).toBe(40); // 60 - 20
      expect(dialogFaceSize(position, 544)).toBe(64); // 136 - 20 = 116: 1x
      expect(dialogFaceSize(position, 816)).toBe(128); // 204 - 20 = 184: 2x
      expect(dialogFaceSize(position, 1088)).toBe(192); // 272 - 20 = 252: 3x
      // Never past the window's inner height.
      for (let height = 120; height <= 1200; height += 7) {
        const face = dialogFaceSize(position, height);
        expect(face).toBeLessThanOrEqual(dialogBoxHeight(position, height) - 20);
        expect(face).toBeGreaterThan(0);
      }
    }
  });

  test("row and block shifts", () => {
    expect(dialogValignShift(undefined, 1)).toBe(0);
    expect(dialogValignShift("top", 1)).toBe(0);
    expect(dialogValignShift("center", 1)).toBe(22);
    expect(dialogValignShift("center", 2)).toBe(15);
    expect(dialogValignShift("bottom", 1)).toBe(45);
    expect(dialogValignShift("bottom", 4)).toBe(0);
    // A page that outgrew four rows (a narrow live window) starts at the top.
    expect(dialogValignShift("bottom", 6)).toBe(0);
    // The 68 px corner box has a 36 px text area, the 136 px one 104 px.
    expect(dialogTextAreaHeight("topLeft", 272)).toBe(36);
    expect(dialogTextAreaHeight("topLeft", 544)).toBe(104);
    expect(dialogTextAreaHeight(undefined, 544)).toBe(60);
    expect(dialogValignShift("center", 1, 36)).toBe(10);
    expect(dialogValignShift("bottom", 2, 36)).toBe(6);
    expect(dialogValignShift("center", 2, 104)).toBe(37);
    expect(dialogValignShift("bottom", 3, 36)).toBe(0);
    expect(dialogAlignShift(undefined, 444, 100)).toBe(0);
    expect(dialogAlignShift("left", 444, 100)).toBe(0);
    expect(dialogAlignShift("center", 444, 100)).toBe(172);
    expect(dialogAlignShift("right", 444, 100)).toBe(344);
    // A row as wide as the column (or wider) is never pushed out of it.
    expect(dialogAlignShift("right", 444, 444)).toBe(0);
    expect(dialogAlignShift("center", 444, 500)).toBe(0);
  });

  test("the dim fill is the paper at a fraction of its opacity", () => {
    expect(translucentColor("#0b1626", 0.6)).toBe("#0b162699");
    expect(translucentColor("#abc", 1)).toBe("#aabbccff");
    expect(translucentColor("#11223380", 0.5)).toBe("#11223340");
    expect(translucentColor("red", 0.5)).toBe("red");
  });
});

describe("pages of a box", () => {
  const long = [
    "从前有一位年轻的训练师，他每天清晨都会去海边散步，看日出。海风吹过沙滩，浪花一层一层地拍打着岸边那些黑色的礁石。",
    "他总是在想，大海的另一边到底住着什么样的怪兽，又有多少个朋友？",
    "有一天，他终于下定了决心，要坐上港口那艘白色的小帆船，去对岸看一看！",
  ];
  test("a narrow box cuts its pages at its own column", () => {
    const paginate = createDialogPaginator({}, measure);
    expect(paginate(long)).toBeNull();
    expect(paginate(long, {})).toBeNull();
    expect(paginate(long, { position: "top", align: "center", background: "dim" })).toBeNull();
    const narrow = paginate(long, { position: "bottomLeft" });
    expect(narrow).toEqual(messagePageStarts(long, { viewportWidth: 480 }, measure, "bottomLeft"));
    // Four rows at 444 px make one page; the corner box holds two rows of
    // 364 px (30 fullwidth characters) a page.
    const rows = flowRows(long, 364, 2, measure).rows.length;
    expect(rows).toBeGreaterThan(4);
    expect(narrow).not.toBeNull();
    expect(narrow!.length).toBe(Math.ceil(rows / 2));
    for (let page = 1; page < narrow!.length; page++) {
      const cut = flowRows(long, 364, 2, measure);
      expect(narrow![page]).toBe(scalarLength(cut.source.slice(0, cut.rows[page * 2]!.start)));
    }
    for (const position of ["topLeft", "topRight", "bottomRight", "left", "right"] as const) {
      expect(paginate(long, { position })).toEqual(narrow);
    }
  });
});

function project(commands: Command[]): Project {
  return {
    format: "rpgkit-project/v1",
    title: "text box layout",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [{
      id: "m",
      name: "m",
      width: 4,
      height: 4,
      sheets: ["plain"],
      ground: new Array(16).fill("plain.0"),
      events: [{
        id: "talk",
        x: 2,
        y: 2,
        pages: [
          { trigger: "autorun", commands: [...commands, { op: "switch", id: "done", value: true }] },
          { condition: { switch: "done" }, trigger: "action", commands: [] },
        ],
      }],
    }],
  };
}

function textModal(state: SessionState): TextModal | null {
  const m = state.interp.modal;
  return m?.kind === "text" ? m : null;
}

describe("the interpreter keeps a text's layout", () => {
  test("only fields that differ from the default box are kept", () => {
    expect(textBoxLayout({})).toBeUndefined();
    expect(textBoxLayout({ position: "bottom", align: "left", valign: "top", background: "window" })).toBeUndefined();
    expect(textBoxLayout({ position: "top", align: "left", background: "dim" })).toEqual({ position: "top", background: "dim" });
    const prog = compile([
      { op: "text", lines: ["a"] },
      { op: "text", lines: ["b"], position: "bottom" },
      { op: "text", lines: ["c"], position: "center", align: "center", valign: "center", background: "transparent" },
    ]);
    const texts = prog.filter((ins): ins is Extract<Instr, { op: "text" }> => ins.op === "text");
    expect(texts[0]).toEqual({ op: "text", lines: ["a"], cps: 30 });
    expect("box" in texts[0]!).toBe(false);
    expect("box" in texts[1]!).toBe(false);
    expect(texts[2]!.box).toEqual({ position: "center", align: "center", valign: "center", background: "transparent" });
  });

  test("the modal carries the box, and the paginator sees it, page after page", () => {
    const seen: (TextBoxLayout | undefined)[] = [];
    const layout: TextBoxLayout = { position: "topRight", align: "right", background: "dim" };
    const p = project([
      { op: "text", lines: ["plain"] },
      { op: "text", lines: ["placed"], ...layout },
    ]);
    // A paginator that splits every message in two, so the box must
    // survive a page turn too.
    const session = createSession(p, 60, {
      paginateText: (lines, box) => {
        seen.push(box);
        return [0, 2];
      },
    });
    let state = startSession(p, session);
    const step = (confirm = false) => {
      state = stepSession(session, state, { buttons: confirm ? 0x2000 : 0, confirmEdge: confirm });
    };
    for (let i = 0; i < 3 && !textModal(state); i++) step();
    expect(textModal(state)!.lines).toEqual(["plain"]);
    expect("box" in textModal(state)!).toBe(false);
    const states: TextModal[] = [];
    for (let i = 0; i < 40 && states.length < 200; i++) {
      step(i % 3 === 0);
      const m = textModal(state);
      if (m && m.lines[0] === "placed") states.push(m);
    }
    expect(states.length).toBeGreaterThan(2);
    expect(new Set(states.map((m) => m.page))).toEqual(new Set([0, 1]));
    for (const m of states) expect(m.box).toEqual(layout);
    expect(seen).toEqual([undefined, layout]);
  });
});

describe("schema", () => {
  const withText = (text: Record<string, unknown>) => project([text as Command]);
  test("every documented value validates; others are refused", () => {
    expect(validateSchema(schema as never, withText({ op: "text", lines: ["a"] }))).toEqual([]);
    for (const position of POSITIONS) {
      expect(validateSchema(schema as never, withText({ op: "text", lines: ["a"], position }))).toEqual([]);
    }
    for (const align of ["left", "center", "right"]) {
      expect(validateSchema(schema as never, withText({ op: "text", lines: ["a"], align }))).toEqual([]);
    }
    for (const valign of ["top", "center", "bottom"]) {
      expect(validateSchema(schema as never, withText({ op: "text", lines: ["a"], valign }))).toEqual([]);
    }
    for (const background of ["window", "dim", "transparent"]) {
      expect(validateSchema(schema as never, withText({ op: "text", lines: ["a"], background }))).toEqual([]);
    }
    for (const bad of [{ position: "middle" }, { align: "justify" }, { valign: "middle" }, { background: "none" }, { anchor: "top" }]) {
      expect(validateSchema(schema as never, withText({ op: "text", lines: ["a"], ...bad })).length).toBeGreaterThan(0);
    }
  });
});

describe("a saved text instruction's box", () => {
  const snapshotWith = (ins: Record<string, unknown>) => {
    const snapshot = createSnapshot("map", initialMovement(1, 2, 0, { tile: 16, speed: 2 }), createInterpState(), 0);
    snapshot.interp.parallels["map/p"] = {
      key: "map/p", pageIndex: 0, parallel: true, stack: [{ prog: [{ op: "wait", frames: 5 }, ins], pc: 0 }], mode: "run", since: 0, erase: false,
    } as never;
    return snapshot;
  };
  const text = (extra: Record<string, unknown>) => ({ op: "text", lines: ["a"], cps: 30, ...extra });

  test("a well-formed box is accepted", () => {
    expect(validateSnapshot(snapshotWith(text({})))).toBeNull();
    expect(validateSnapshot(snapshotWith(text({ box: { position: "topLeft", align: "center", valign: "bottom", background: "dim" } })))).toBeNull();
  });

  test("a malformed box is refused", () => {
    for (const box of [{}, { position: "middle" }, { align: 1 }, { anchor: "top" }, "top", null]) {
      const error = validateSnapshot(snapshotWith(text({ box })));
      expect({ box, error: error?.includes(".box") ?? false }).toEqual({ box, error: true });
    }
  });
});
