import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateRpgMakerFormula,
  parseRpgMakerFormula,
  RpgMakerFormulaError,
  type RpgMakerFormulaBattler,
} from "../src/rpgmaker-battle/formula.ts";

const battler = (values: Partial<RpgMakerFormulaBattler> = {}): RpgMakerFormulaBattler => ({
  hp: 40,
  mp: 12,
  tp: 0,
  mhp: 40,
  mmp: 12,
  atk: 10,
  def: 6,
  mat: 8,
  mdf: 7,
  agi: 5,
  luk: 4,
  level: 3,
  ...values,
});

const context = {
  a: battler(),
  b: battler({ hp: 25, def: 7, mdf: 5 }),
  variables: { 1: 9, 4: -2 },
};

const run = (source: string): number => evaluateRpgMakerFormula(parseRpgMakerFormula(source), context);

describe("safe RPG Maker formula subset", () => {
  test("respects JavaScript arithmetic, exponent and unary precedence", () => {
    expect(run("1 + 2 * 3 ** 2 - -4")).toBe(23);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("20 / 4 + 7 % 4")).toBe(8);
  });

  test("reads allowlisted a/b parameters and numeric v indexes", () => {
    expect(run("a.atk * 4 - b.def * 2 + v[1]")).toBe(35);
    expect(run("a.level + b.hp + v[99]")).toBe(28);
  });

  test("supports comparisons, short circuit and right-associative ternaries", () => {
    expect(run("a.hp < b.hp ? 1 : a.mp >= 10 ? 20 : 30")).toBe(20);
    expect(run("0 && (1 / 0)")).toBe(0);
    expect(run("v[4] || 7")).toBe(-2);
    expect(run("!(a.atk === b.atk) || a.hp !== b.hp")).toBe(1);
  });

  test("supports deterministic common Math members", () => {
    expect(run("Math.max(1, Math.floor(a.atk / 3), Math.abs(v[4]))")).toBe(3);
    expect(run("Math.round(Math.pow(3, 2) + Math.sqrt(16))")).toBe(13);
    expect(run("Math.PI > 3 && Math.E > 2")).toBe(1);
  });

  test("turns non-finite arithmetic into deterministic zero", () => {
    expect(run("1 / 0")).toBe(0);
    expect(run("Math.sqrt(-1)")).toBe(0);
  });

  test.each([
    "globalThis.process.exit()",
    "a.constructor",
    "a.atk = 999",
    "v[a.level]",
    "Math.random()",
    "Math.max.apply(null, [1, 2])",
    "(() => 7)()",
    "this.atk",
    "a.hp; 7",
  ])("rejects source outside the allowlist: %s", (source) => {
    expect(() => parseRpgMakerFormula(source)).toThrow(RpgMakerFormulaError);
  });

  test("the implementation contains no dynamic source execution", () => {
    const source = readFileSync(join(import.meta.dir, "../src/rpgmaker-battle/formula.ts"), "utf8");
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/new\s+Function\s*\(/);
  });
});

