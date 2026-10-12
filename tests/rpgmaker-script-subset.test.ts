import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recognizeScriptActions,
  recognizeScriptCondition,
} from "../tools/rpgmaker-import/script-subset.ts";

describe("RPG Maker safe Script action subset", () => {
  test.each([
    ["$gameMap.requestRefresh();", { kind: "refreshMap" }],
    [
      "$gameVariables.setValue(12, $gameVariables.value(3) + 4 * 2);",
      { kind: "setVariable", id: 12, value: { kind: "binary", op: "+" } },
    ],
    ["$gameSwitches.setValue(7, false);", { kind: "setSwitch", id: 7, value: false }],
    [
      "$gameSelfSwitches.setValue([2, 9, 'C'], true);",
      { kind: "setSelfSwitch", mapId: 2, eventId: 9, key: "C", value: true },
    ],
    [
      "$gameParty.gainItem($dataItems[4], 2);",
      { kind: "changeItem", operation: "gain", itemKind: "item", id: 4, includeEquipment: false },
    ],
    [
      "$gameParty.loseItem($dataWeapons[3], 1, true);",
      { kind: "changeItem", operation: "lose", itemKind: "weapon", id: 3, includeEquipment: true },
    ],
    ["$gameParty.gainGold($gameVariables.value(5));", { kind: "changeGold", operation: "gain" }],
    ["$gameParty.loseGold(40);", { kind: "changeGold", operation: "lose" }],
    ["$gamePlayer.locate(8, 11);", { kind: "locatePlayer" }],
    ["$gamePlayer.reserveTransfer(3, 4, 5, 6, 2);", { kind: "reserveTransfer", direction: 6, fadeType: 2 }],
    ["$gameMap.event(2).setPosition(6, 7);", { kind: "setEventPosition", eventId: 2 }],
    ["$gameMap.event(2).setDirection(8);", { kind: "setEventDirection", eventId: 2, direction: 8 }],
    [
      "AudioManager.playSe({name: 'Bell', volume: 80, pitch: 110, pan: -20});",
      { kind: "playAudio", audioKind: "se", audio: { name: "Bell", volume: 80, pitch: 110, pan: -20 } },
    ],
    ["AudioManager.playBgm({name: 'Theme'});", { kind: "playAudio", audioKind: "bgm", audio: { name: "Theme" } }],
    ["$gameMessage.add('Safe \\u4e2d text');", { kind: "addMessage", text: "Safe 中 text" }],
  ] as const)("recognizes and normalizes %s", (source, expected) => {
    const result = recognizeScriptActions(source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.actions[0]).toMatchObject(expected);
  });

  test("accepts a sequence only when every statement is allowlisted", () => {
    const accepted = recognizeScriptActions(
      "$gameSwitches.setValue(1, true); $gameVariables.setValue(2, Math.max(3, 4));",
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.actions.map((action) => action.kind)).toEqual(["setSwitch", "setVariable"]);

    const rejected = recognizeScriptActions(
      "$gameSwitches.setValue(1, true); globalThis.sideEffect();",
    );
    expect(rejected).toMatchObject({ ok: false, shape: "unsupported action shape" });
  });
});

describe("RPG Maker safe Script condition subset", () => {
  test.each([
    ["$gameVariables.value(3) >= 9", { kind: "variable", id: 3, op: ">=", value: 9 }],
    ["9 < $gameVariables.value(3)", { kind: "variable", id: 3, op: ">", value: 9 }],
    ["$gameParty.hasItem($dataItems[2])", { kind: "item", itemKind: "item", id: 2, negate: false }],
    ["!$gameParty.hasItem($dataArmors[7], true)", { kind: "item", itemKind: "armor", id: 7, includeEquipment: true, negate: true }],
    ["$gameSwitches.value(6)", { kind: "switch", id: 6, negate: false }],
    ["!$gameSwitches.value(6)", { kind: "switch", id: 6, negate: true }],
    ["$gamePlayer.x === 12", { kind: "playerCoordinate", axis: "x", op: "===", value: 12 }],
    ["4 != $gamePlayer.y", { kind: "playerCoordinate", axis: "y", op: "!=", value: 4 }],
    ["$gamePlayer.direction() == 2", { kind: "playerDirection", op: "==", value: 2 }],
    ["$gameParty.steps() < 20", { kind: "steps", op: "<", value: 20 }],
    ["$gameParty.numItems($dataItems[4]) >= 2", { kind: "itemCount", itemKind: "item", id: 4, op: ">=", value: 2 }],
    ["3 > $gameParty.numItems($dataArmors[1])", { kind: "itemCount", itemKind: "armor", id: 1, op: "<", value: 3 }],
  ] as const)("recognizes %s", (source, expected) => {
    const result = recognizeScriptCondition(source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.condition).toMatchObject(expected);
  });
});

describe("RPG Maker Script subset fails closed", () => {
  test.each([
    "globalThis.process.exit()",
    "require('node:fs').readFileSync('secret')",
    "import('payload')",
    "({}).constructor.constructor('return globalThis')()",
    "$gameVariables.__proto__.setValue(1, 2)",
    "$gameVariables.setValue(1, 2); sideEffect()",
    "$gameVariables.setValue(1, sideEffect())",
    "$gameVariables.setValue(0, 2)",
    "$gameVariables.setValue(10000, 2)",
    "$gameSwitches.setValue(1, true || sideEffect())",
    "AudioManager.playSe({name: 'Bell', constructor: sideEffect()})",
    "this.constructor.constructor('return 1')()",
    "(()=>7)()",
  ])("rejects action source outside the exact allowlist: %s", (source) => {
    const result = recognizeScriptActions(source);
    expect(result.ok).toBe(false);
  });

  test.each([
    "$gameVariables.value(1) > 0 && sideEffect()",
    "$gameParty.hasItem($dataItems[1]) || sideEffect()",
    "globalThis.secret",
    "require('x')",
    "import('x')",
    "$gamePlayer.constructor === 1",
    "$gameVariables.value(0) === 1",
    "$gameVariables.value(10000) === 1",
    "$gameVariables.value(1) === 1; sideEffect()",
  ])("rejects condition source outside the exact allowlist: %s", (source) => {
    expect(recognizeScriptCondition(source).ok).toBe(false);
  });

  test("never executes a rejected call or leaks its text into the reason", () => {
    let touched = false;
    const holder = globalThis as typeof globalThis & { __rmiAttack?: () => void };
    holder.__rmiAttack = () => { touched = true; };
    try {
      const source = "$gameVariables.setValue(1, 2); globalThis.__rmiAttack('SECRET_TOKEN')";
      const result = recognizeScriptActions(source);
      expect(result.ok).toBe(false);
      expect(touched).toBe(false);
      expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
    } finally {
      delete holder.__rmiAttack;
    }
  });

  test("enforces source, token, statement, argument, and depth budgets", () => {
    expect(recognizeScriptActions("x".repeat(2_049))).toMatchObject({ ok: false, reason: "exceeds 2048 characters" });
    expect(recognizeScriptActions(`${"1+".repeat(256)}1`)).toMatchObject({ ok: false, reason: "exceeds 512 tokens" });
    expect(recognizeScriptActions(Array(33).fill("$gameSwitches.setValue(1,true)").join(";")))
      .toMatchObject({ ok: false, reason: "exceeds 32 statements" });
    expect(recognizeScriptActions(`$gameMessage.add(${Array(34).fill("'x'").join(",")})`))
      .toMatchObject({ ok: false, reason: "too many call arguments" });
    expect(recognizeScriptActions(`${"(".repeat(65)}1${")".repeat(65)}`))
      .toMatchObject({ ok: false, reason: "exceeds AST depth 64" });
  });

  test("the recognizer contains no dynamic source execution", () => {
    const source = readFileSync(join(import.meta.dir, "../tools/rpgmaker-import/script-subset.ts"), "utf8");
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/\bFunction\s*\(/);
  });
});

