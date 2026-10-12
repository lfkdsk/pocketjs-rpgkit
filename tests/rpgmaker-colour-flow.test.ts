import { describe, expect, test } from "bun:test";
import { revealChoiceColourRuns as revealColourRuns } from "../src/ui/choice-colour.ts";
import { flowRows } from "../src/ui/text-flow.ts";

const measure = (text: string): number => Array.from(text).length;

describe("RPG Maker colour flow", () => {
  test("splits wrapped CJK and emoji rows at global code-point colour boundaries", () => {
    const flow = flowRows(["红😀蓝白", "青黄"], 3, 4, measure);
    expect(flow.rows.map((row) => row.text)).toEqual(["红😀蓝", "白", "青黄"]);
    expect(revealColourRuns(flow, 99, [
      { start: 0, end: 2, colour: "#FF0000" },
      { start: 2, end: 7, colour: "#00FF00" },
    ])).toEqual([
      [
        { text: "红😀", colour: "#FF0000" },
        { text: "蓝", colour: "#00FF00" },
      ],
      [{ text: "白", colour: "#00FF00" }],
      [{ text: "青黄", colour: "#00FF00" }],
    ]);
  });

  test("keeps soft-joined newlines zero-width while they consume typewriter and colour offsets", () => {
    const flow = flowRows(["甲乙", "丙丁"], 4, 1, measure);
    expect(flow.rows.map((row) => row.text)).toEqual(["甲乙丙丁"]);
    expect(revealColourRuns(flow, 3, [
      { start: 0, end: 2, colour: "#111111" },
      { start: 3, end: 5, colour: "#222222" },
    ])).toEqual([[
      { text: "甲乙", colour: "#111111" },
    ]]);
    expect(revealColourRuns(flow, 4, [
      { start: 0, end: 2, colour: "#111111" },
      { start: 3, end: 5, colour: "#222222" },
    ])).toEqual([[
      { text: "甲乙", colour: "#111111" },
      { text: "丙", colour: "#222222" },
    ]]);
  });

  test("applies a later page's full-message offset without recolouring its prefix", () => {
    const flow = flowRows(["Page two"], 20, 4, measure);
    expect(revealColourRuns(flow, 99, [
      { start: 0, end: 8, colour: "#AAAAAA" },
      { start: 10, end: 14, colour: "#BBBBBB" },
    ], 8)).toEqual([[
      { text: "Pa" },
      { text: "ge t", colour: "#BBBBBB" },
      { text: "wo" },
    ]]);
  });
});
