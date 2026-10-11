import { describe, expect, test } from "bun:test";
import { scalarLength } from "../src/engine/text-break.ts";
import {
  fitChoiceColourCell,
  wrapChoiceColourRows,
} from "../src/ui/choice-colour.ts";

const measure = (text: string): number => scalarLength(text);

describe("RPG Maker choice colour layout", () => {
  test("maps code-point spans through CJK/emoji wrapping without colouring adjacent theme text", () => {
    const rows = wrapChoiceColourRows("甲😀乙丙", 2, measure, [
      { start: 1, end: 3, colour: "#123456" },
    ]);
    expect(rows).toEqual([
      {
        text: "甲😀",
        runs: [{ text: "甲" }, { text: "😀", colour: "#123456" }],
      },
      {
        text: "乙丙",
        runs: [{ text: "乙", colour: "#123456" }, { text: "丙" }],
      },
    ]);
  });

  test("keeps the full source and colour boundaries when an over-tall label becomes a marquee", () => {
    const cell = fitChoiceColourCell("甲😀乙丙", 1, 1, measure, [
      { start: 1, end: 3, colour: "#ABCDEF" },
    ]);
    expect(cell.layout).toEqual({ kind: "marquee", rows: ["甲😀乙丙"], overflow: 3 });
    expect(cell.rows).toEqual([{
      text: "甲😀乙丙",
      runs: [
        { text: "甲" },
        { text: "😀乙", colour: "#ABCDEF" },
        { text: "丙" },
      ],
    }]);
  });

  test("advances colour offsets over hanging spaces omitted at a wrap", () => {
    const rows = wrapChoiceColourRows("甲 乙丙", 2, measure, [
      { start: 2, end: 4, colour: "#654321" },
    ]);
    expect(rows.map((row) => row.text).join("")).toBe("甲乙丙");
    expect(rows.flatMap((row) => row.runs)).toContainEqual({ text: "乙丙", colour: "#654321" });
  });
});
