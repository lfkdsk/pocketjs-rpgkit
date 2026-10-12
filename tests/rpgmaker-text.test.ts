import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MV_COLOURS,
  parseRpgMakerText,
  type RpgMakerTextContext,
} from "../src/engine/rpgmaker-text.ts";
import { layoutRpgMakerTextRuns } from "../src/ui/choice-colour.ts";

function context(overrides: Partial<RpgMakerTextContext> = {}): RpgMakerTextContext {
  return {
    variables: { v002: 5 },
    actors: [
      { databaseId: 7, name: "勇者😀" },
      { databaseId: 9, name: "Mage" },
    ],
    partyActorIds: [9, 7],
    currencyUnit: "Ｇ",
    ...overrides,
  };
}

describe("parseRpgMakerText", () => {
  test("resolves variables, actors, party members and currency case-insensitively in one pass", () => {
    const result = parseRpgMakerText(
      String.raw`\v[1] / \V[2] / \n[7] / \P[2] / \g`,
      context({
        variables: { alias: String.raw`\N[9]`, v002: 5 },
        variableIds: { 1: "alias" },
      }),
    );

    expect(result).toEqual({
      text: "\\N[9] / 5 / 勇者😀 / 勇者😀 / Ｇ",
      unsupported: [],
    });
  });

  test("uses global Unicode-code-point colour offsets across emoji, CJK and newlines", () => {
    const result = parseRpgMakerText("\\C[2]红😀\n青\\c[0]白", context());

    expect(DEFAULT_MV_COLOURS).toHaveLength(32);
    expect(result).toEqual({
      text: "红😀\n青白",
      spans: [
        { start: 0, end: 4, colour: "#FF784C" },
        { start: 4, end: 5, colour: "#FFFFFF" },
      ],
      unsupported: [],
    });
  });

  test("records MZ position and font-size assignments at visible code-point offsets", () => {
    const result = parseRpgMakerText(
      "a\\PX[10]b\\py[20]\\FS[28]中\\px[1]\\PY[2]\\fs[30]😀",
      context(),
    );

    expect(result).toEqual({
      text: "ab中😀",
      layout: [
        { at: 1, x: 10 },
        { at: 2, y: 20, fontSize: 28 },
        { at: 3, x: 1, y: 2, fontSize: 30 },
      ],
      unsupported: [],
    });
  });

  test("preserves unknown and malformed escapes exactly", () => {
    const input = String.raw`\I[2] \V[x] \N[] \P[-1] \C[1 \PX[] \FS[999999999999999999999999]`;
    expect(parseRpgMakerText(input, context())).toEqual({ text: input, unsupported: [] });
  });

  test("turns doubled slashes into literals without parsing what follows", () => {
    const input = String.raw`literal \\V[2], slash \\, colour \\C[2]`;
    const text = String.raw`literal \V[2], slash \, colour \C[2]`;
    expect(parseRpgMakerText(input, context())).toEqual({ text, unsupported: [] });
  });

  test("uses a custom palette and falls back to its colour zero out of range", () => {
    const result = parseRpgMakerText(
      String.raw`\C[1]x\C[99]y`,
      context({ colours: ["#010203", "#abcdef"] }),
    );

    expect(result).toEqual({
      text: "xy",
      spans: [
        { start: 0, end: 1, colour: "#ABCDEF" },
        { start: 1, end: 2, colour: "#010203" },
      ],
      unsupported: [],
    });
  });

  test("merges adjacent runs when repeated and zero-width colour changes select the same colour", () => {
    expect(parseRpgMakerText(String.raw`\C[1]a\C[1]b`, context()).spans).toEqual([
      { start: 0, end: 2, colour: "#20A0D6" },
    ]);
    expect(parseRpgMakerText(String.raw`\C[1]a\C[0]\C[1]` + "😀b", context()).spans).toEqual([
      { start: 0, end: 3, colour: "#20A0D6" },
    ]);
  });

  test("uses RPG Maker's zero and empty fallbacks for missing data", () => {
    expect(parseRpgMakerText(
      String.raw`\V[404]|\N[404]|\P[0]|\P[404]`,
      context(),
    )).toEqual({ text: "0|||", unsupported: [] });
  });
});

describe("MZ message layout", () => {
  test("PX/PY assign the cursor and FS changes measured font runs without consuming reveal steps", () => {
    const parsed = parseRpgMakerText(
      String.raw`a\PX[26]b\PY[52]\FS[30]\C[2]` + "中\nc",
      context(),
    );
    const measureSlot = (slot: number) => (text: string) => Array.from(text).length * (slot === 1 ? 7 : 6);

    expect(layoutRpgMakerTextRuns(
      parsed.text,
      3,
      parsed.layout!,
      parsed.spans!,
      measureSlot,
    )).toEqual([
      { text: "a", x: 0, y: 0, width: 6, fontSlot: 0, lineHeight: 15 },
      { text: "b", x: 12, y: 0, width: 6, fontSlot: 0, lineHeight: 15 },
      { text: "中", colour: "#FF784C", x: 18, y: 24, width: 7, fontSlot: 1, lineHeight: 17 },
    ]);
    expect(layoutRpgMakerTextRuns(
      parsed.text,
      5,
      parsed.layout!,
      parsed.spans!,
      measureSlot,
    ).at(-1)).toEqual({
      text: "c", colour: "#FF784C", x: 0, y: 41, width: 7, fontSlot: 1, lineHeight: 17,
    });
  });
});
