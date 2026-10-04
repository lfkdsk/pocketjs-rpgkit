// tests/krm2-ui.test.ts — pure UI projection and host-effect contracts.

import { describe, expect, test } from "bun:test";
import { NUMBER_INPUT_SCENE_ID } from "../src/engine/index.ts";
import type { TimerState } from "../src/engine/interpreter.ts";
import type { PictureState, ScreenEffectsState } from "../src/engine/screen.ts";
import {
  mapNameBannerOpacity,
  pictureRenderStyle,
  pictureToneOverlays,
  screenEffectsFingerprint,
  sortedPictures,
  timerHudText,
} from "../src/ui/krm2-ui.ts";
import {
  dispatchGameViewHostActions,
  dispatchGameViewHostEffects,
  type GameViewHostCallbacks,
} from "../src/ui/game-host-actions.ts";
import type { GameViewSessionHost } from "../src/ui/demo-contract.ts";
import type { SaveSnapshot } from "../src/engine/save.ts";

function picture(id: number, overrides: Partial<PictureState> = {}): PictureState {
  return {
    id,
    layer: "pictures",
    variant: `p${id}`,
    origin: "topLeft",
    blend: "normal",
    transform: { x: 12, y: 34, scaleX: 100, scaleY: 100, opacity: 255 },
    tone: { r: 0, g: 0, b: 0, gray: 0 },
    rotation: 0,
    rotationSpeed: 0,
    ...overrides,
  };
}

describe("KRM2 picture presentation", () => {
  test("pictures paint in numeric id order, independent of record order", () => {
    const pictures = {
      "20": picture(20),
      "3": picture(3),
      "11": picture(11),
    };
    expect(sortedPictures(pictures).map((entry) => entry.id)).toEqual([3, 11, 20]);
    expect(sortedPictures(undefined)).toEqual([]);
  });

  test("layout applies size, origin, scale, opacity and rotation", () => {
    const centered = picture(1, {
      origin: "center",
      transform: { x: 100, y: 80, scaleX: 150, scaleY: 50, opacity: 128 },
      rotation: 45,
    });
    expect(pictureRenderStyle(centered, { image: "portrait", opacity: 0.5, w: 40, h: 20 }, 480, 272))
      .toEqual({
        insetL: 80,
        insetT: 70,
        width: 40,
        height: 20,
        scaleX: 1.5,
        scaleY: 0.5,
        rotate: 45,
        originX: 0,
        originY: 0,
        opacity: (128 / 255) * 0.5,
      });

    const topLeft = picture(2);
    expect(pictureRenderStyle(topLeft, { image: "full" }, 640, 360)).toMatchObject({
      insetL: 12,
      insetT: 34,
      width: 640,
      height: 360,
      originX: -0.5,
      originY: -0.5,
    });
  });

  test("tone projection is a stable portable overlay approximation", () => {
    expect(pictureToneOverlays({ r: 0, g: 0, b: 0, gray: 0 })).toEqual([]);
    expect(pictureToneOverlays({ r: 128, g: 64, b: 0, gray: 64 })).toEqual([
      { kind: "gray", color: "#808080", opacity: 64 / 255 },
      { kind: "brighten", color: "#ff8000", opacity: 128 / 255 },
    ]);
    expect(pictureToneOverlays({ r: -128, g: 0, b: -64, gray: 0 })).toEqual([
      { kind: "darken", color: "#00ff80", opacity: 128 / 255 },
    ]);
  });

  test("presentation fingerprint observes pictures, banner and timer", () => {
    expect(screenEffectsFingerprint(undefined, undefined)).toBe("");
    const base: ScreenEffectsState = { pictures: { "1": picture(1) } };
    const moved: ScreenEffectsState = {
      pictures: { "1": picture(1, { transform: { x: 13, y: 34, scaleX: 100, scaleY: 100, opacity: 255 } }) },
    };
    expect(screenEffectsFingerprint(base, undefined)).not.toBe(screenEffectsFingerprint(moved, undefined));
    expect(screenEffectsFingerprint({ mapNameBanner: { text: "Harbor", total: 180, left: 90 } }, undefined))
      .not.toBe("");
    const timerA: TimerState = { remaining: 120, running: true, expired: false };
    const timerB: TimerState = { remaining: 119, running: true, expired: false };
    const timerC: TimerState = { remaining: 118, running: true, expired: false };
    expect(screenEffectsFingerprint(undefined, timerA)).not.toBe(screenEffectsFingerprint(undefined, timerB));
    expect(screenEffectsFingerprint(undefined, timerB)).toBe(screenEffectsFingerprint(undefined, timerC));
    expect(screenEffectsFingerprint(undefined, { remaining: 0, running: true, expired: true })).not.toBe("");
  });
});

describe("KRM2 timer, map-name and host presentation", () => {
  test("timer text keeps arbitrarily long minutes instead of truncating", () => {
    expect(timerHudText(undefined)).toBe("00:00");
    expect(timerHudText({ remaining: 65 * 60, running: true, expired: false })).toBe("01:05");
    expect(timerHudText({ remaining: (123_456 * 60 + 7) * 60, running: true, expired: false }))
      .toBe("123456:07");
    expect(timerHudText({ remaining: 0, running: true, expired: true })).toBe("00:00");
  });

  test("map-name opacity is derived only from saved banner ticks", () => {
    expect(mapNameBannerOpacity({ text: "Map", total: 180, left: 180 })).toBe(0);
    expect(mapNameBannerOpacity({ text: "Map", total: 180, left: 165 })).toBe(1);
    expect(mapNameBannerOpacity({ text: "Map", total: 180, left: 30 })).toBe(1);
    expect(mapNameBannerOpacity({ text: "Map", total: 180, left: 15 })).toBe(0.5);
    expect(mapNameBannerOpacity({ text: "Map", total: 180, left: 0 })).toBe(0);
  });

  test("host callbacks run once each in reducer order; missing callbacks are no-ops", () => {
    const seen: string[] = [];
    const host = {} as GameViewSessionHost;
    const callbacks: GameViewHostCallbacks = {
      menu: (received) => { expect(received).toBe(host); seen.push("menu"); },
      save: () => { seen.push("save"); },
      gameOver: () => { seen.push("gameOver"); },
      title: () => { seen.push("title"); },
    };
    dispatchGameViewHostActions(["save", "menu", "save", "gameOver", "title"], callbacks, host);
    expect(seen).toEqual(["save", "menu", "save", "gameOver", "title"]);
    expect(() => dispatchGameViewHostActions(["menu", "save"], undefined, host)).not.toThrow();
  });

  test("autosave dispatch carries its tick snapshot and ignores manual save access", () => {
    const snapshot = { autosave: true, held: 0x2000 } as SaveSnapshot;
    const host = {
      getState: () => ({ sw: { saveAccess: false } }),
    } as unknown as GameViewSessionHost;
    const seen: string[] = [];
    dispatchGameViewHostEffects([
      { action: "save" },
      { action: "autosave", snapshot },
      { action: "title" },
    ], {
      save: () => seen.push("save"),
      autosave: (receivedHost, receivedSnapshot) => {
        expect(receivedHost).toBe(host);
        expect(receivedSnapshot).toBe(snapshot);
        seen.push("autosave");
      },
      title: () => seen.push("title"),
    }, host);
    expect(seen).toEqual(["autosave", "title"]);
  });

  test("number input engine id is available from the public export", () => {
    expect(NUMBER_INPUT_SCENE_ID).toBe("rpgkit.numberInput");
  });
});
