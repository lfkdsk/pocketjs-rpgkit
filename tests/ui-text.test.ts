// tests/ui-text.test.ts — the interface-word table (src/engine/ui-text.ts)
// without a renderer: templates, merging, the defaults each component owns,
// the schema's `uiText` property, menuStep's empty-slot message, and that
// the table never reaches session state.

import { describe, expect, test } from "bun:test";
import {
  KIT_UI_TEXT,
  formatUiText,
  mergeUiText,
  withUiText,
  type UiTextKey,
  type UiTextTable,
} from "../src/engine/ui-text.ts";
import { ROOT_CODE, ROOT_FS, SAVE_MENU_UI_TEXT, menuStep } from "../src/engine/save-menu.ts";
import { NAME_INPUT_UI_TEXT } from "../src/engine/name-input.ts";
import { DEMO_MENU_UI_TEXT } from "../src/ui/demo/text.ts";
import { STAT_BAR_UI_TEXT } from "../src/ui/battle/text.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { createSession, startSession } from "../src/engine/session.ts";
import { canonicalJson } from "../src/engine/save.ts";
import schema from "../src/data/schema.json";
import { applyEditPatch, createEditPatch } from "../editor/api/operations.ts";
import { fixtureProject, ZH_UI_TEXT } from "./fixtures/ui-text/fixture-data.ts";

const GROUPS = { KIT_UI_TEXT, SAVE_MENU_UI_TEXT, NAME_INPUT_UI_TEXT, DEMO_MENU_UI_TEXT, STAT_BAR_UI_TEXT };
// Compiles only while the groups together cover every key of UiTextTable.
const ENGLISH: UiTextTable = { ...KIT_UI_TEXT, ...SAVE_MENU_UI_TEXT, ...NAME_INPUT_UI_TEXT, ...DEMO_MENU_UI_TEXT, ...STAT_BAR_UI_TEXT };

describe("formatUiText", () => {
  test("fills named placeholders anywhere in the sentence", () => {
    expect(formatUiText("Gold: {gold}", { gold: 500 })).toBe("Gold: 500");
    expect(formatUiText("{slot}号存档位是空的", { slot: 1 })).toBe("1号存档位是空的");
    expect(formatUiText("{price}金（剩{stock}）", { price: 200, stock: 3 })).toBe("200金（剩3）");
  });

  test("leaves unknown placeholders, other braces and the {name} token alone; values are not rescanned", () => {
    expect(formatUiText("{gold} {missing} {name} {} {1x}", { gold: "{missing}" })).toBe("{missing} {missing} {name} {} {1x}");
    expect(formatUiText("no braces", { gold: 1 })).toBe("no braces");
  });
});

describe("merging and defaults", () => {
  test("no override builds nothing: the defaults object itself comes back", () => {
    expect(mergeUiText(undefined, null, {})).toBeUndefined();
    expect(withUiText(KIT_UI_TEXT, undefined)).toBe(KIT_UI_TEXT);
    expect(withUiText(KIT_UI_TEXT, { "save.title": "x" })).toBe(KIT_UI_TEXT);
  });

  test("later layers win; non-strings are dropped; missing keys keep English", () => {
    const merged = mergeUiText({ "shop.buy": "购买", "shop.sell": "出售" }, { "shop.buy": "买" }, { "shop.gold": 5 as never });
    expect(merged).toEqual({ "shop.buy": "买", "shop.sell": "出售" });
    const words = withUiText(KIT_UI_TEXT, merged);
    expect(words["shop.buy"]).toBe("买");
    expect(words["shop.sell"]).toBe("出售");
    expect(words["shop.gold"]).toBe("Gold: {gold}");
    expect(words).not.toBe(KIT_UI_TEXT);
    expect(KIT_UI_TEXT["shop.buy"]).toBe("Buy");
  });

  test("each key has exactly one owner, and the schema lists exactly the keys", () => {
    const owners = new Map<string, string>();
    for (const [group, table] of Object.entries(GROUPS)) {
      for (const key of Object.keys(table)) {
        expect(owners.get(key), `${key} in ${group} and ${owners.get(key)}`).toBeUndefined();
        owners.set(key, group);
      }
    }
    const schemaKeys = Object.keys((schema as { properties: { uiText: { properties: Record<string, unknown> } } }).properties.uiText.properties);
    expect([...owners.keys()].sort()).toEqual(schemaKeys.sort());
    expect(Object.keys(ZH_UI_TEXT).sort()).toEqual(schemaKeys.sort());
    expect(Object.keys(ENGLISH).length).toBe(schemaKeys.length);
  });

  test("the schema documents each key's English default", () => {
    const props = (schema as { properties: { uiText: { properties: Record<string, { description: string }> } } }).properties.uiText.properties;
    for (const [key, english] of Object.entries(ENGLISH)) {
      expect(props[key]!.description).toBe(`Default: ${JSON.stringify(english)}`);
    }
  });

  test("the save menu's root rows carry their default as the label", () => {
    for (const row of [...ROOT_FS, ...ROOT_CODE]) expect(row.label).toBe(SAVE_MENU_UI_TEXT[row.textKey as keyof typeof SAVE_MENU_UI_TEXT]);
  });
});

describe("menuStep's empty-slot message", () => {
  const ctx = { hasFs: true, slotNonEmpty: [false, true, true], codePages: 1 };

  test("is English without a table, as before", () => {
    const step = menuStep({ kind: "slots-load", index: 0 }, "confirm", ctx);
    expect(step.state).toEqual({
      kind: "message",
      title: "SLOT 1 IS EMPTY",
      body: "Nothing to load there.",
      back: { kind: "slots-load", index: 0 },
    });
  });

  test("uses the game's words, slot number placed by the template", () => {
    const step = menuStep({ kind: "slots-load", index: 0 }, "confirm", { ...ctx, text: ZH_UI_TEXT });
    expect(step.state).toMatchObject({ kind: "message", title: "1号存档位是空的", body: "这里没有可以读取的存档。" });
    const partial = menuStep({ kind: "slots-load", index: 0 }, "confirm", { ...ctx, text: { "save.emptyBody": "空" } });
    expect(partial.state).toMatchObject({ title: "SLOT 1 IS EMPTY", body: "空" });
  });
});

describe("Project.uiText in the schema", () => {
  test("a project with a full or partial table validates", () => {
    expect(validateSchema(schema, fixtureProject("idle", ZH_UI_TEXT))).toEqual([]);
    expect(validateSchema(schema, fixtureProject("idle", { "shop.buy": "购买" }))).toEqual([]);
    expect(validateSchema(schema, fixtureProject("idle", {}))).toEqual([]);
  });

  test("an unknown key or a non-string value is refused", () => {
    expect(validateSchema(schema, fixtureProject("idle", { "shop.bye": "x" } as never)).length).toBeGreaterThan(0);
    expect(validateSchema(schema, fixtureProject("idle", { "shop.buy": 3 } as never)).length).toBeGreaterThan(0);
  });

  test("each key accepts its own maxLength and rejects one code unit more", () => {
    const properties = (schema as {
      properties: { uiText: { properties: Record<UiTextKey, { maxLength: number }> } };
    }).properties.uiText.properties;
    for (const [key, property] of Object.entries(properties) as [UiTextKey, { maxLength: number }][]) {
      const atLimit = "的".repeat(property.maxLength);
      const overLimit = `${atLimit}的`;
      expect(validateSchema(schema, fixtureProject("idle", { [key]: atLimit })), `${key} at maxLength`).toEqual([]);
      expect(validateSchema(schema, fixtureProject("idle", { [key]: overLimit })), `${key} over maxLength`).toContainEqual({
        path: `$.uiText.${key}`,
        msg: `maxLength ${property.maxLength}`,
      });
    }
  });

  test("the table never enters session state: same state with or without it", () => {
    const run = (uiText: Partial<UiTextTable> | undefined) => {
      const project = fixtureProject("shop", uiText);
      const session = createSession(project, 60);
      return canonicalJson(startSession(project, session));
    };
    const plain = run(undefined);
    expect(run(ZH_UI_TEXT)).toBe(plain);
    expect(plain.includes("购买")).toBe(false);
  });
});

test("every UiTextKey used by the kit is a key of the table (type-level, here for the record)", () => {
  const keys: UiTextKey[] = Object.keys(ENGLISH) as UiTextKey[];
    expect(keys.length).toBe(85);
});

describe("editing uiText through editor/api", () => {
  test("a patch adds and changes words; a bad key is refused", () => {
    const before = fixtureProject("idle", undefined);
    const after = fixtureProject("idle", { "shop.buy": "购买", "legend.next": "下一页" });
    const applied = applyEditPatch(before, createEditPatch(before, after));
    expect(applied).toEqual(after);
    const back = applyEditPatch(applied, createEditPatch(after, before));
    expect(back).toEqual(before);
    const bad = fixtureProject("idle", { "shop.bye": "x" } as never);
    expect(() => applyEditPatch(before, createEditPatch(before, bad))).toThrow(/uiText/);
  });
});
