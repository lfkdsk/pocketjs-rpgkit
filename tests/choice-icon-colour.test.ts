import { describe, expect, test } from "bun:test";
import { choiceRunColour, wrapChoiceColourRows } from "../src/ui/choice-colour.ts";

describe("choice icon inline colours", () => {
  test("explicit runs override selected and disabled colours while plain runs inherit them", () => {
    const [row] = wrapChoiceColourRows("red plain", 100, (text) => text.length, [
      { start: 0, end: 3, colour: "#D02020" },
    ]);
    expect(row!.runs).toEqual([
      { text: "red", colour: "#D02020" },
      { text: " plain" },
    ]);
    for (const rowColour of ["#40A0FF", "#707070"]) {
      expect(row!.runs.map((run) => choiceRunColour(run, rowColour))).toEqual(["#D02020", rowColour]);
    }
  });
});
