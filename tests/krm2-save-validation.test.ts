import { describe, expect, test } from "bun:test";
import {
  compile,
  createInterpState,
} from "../src/engine/interpreter.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { createSnapshot, type SaveSnapshot } from "../src/engine/save.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import {
  advanceScreenEffects,
  movePicture,
  showPicture,
  tintPicture,
  type ScreenEffectsState,
} from "../src/engine/screen.ts";
import type { Command } from "../src/engine/types.ts";

const FIBER = "map/parallel";

function baseSnapshot(): SaveSnapshot {
  return createSnapshot(
    "map",
    initialMovement(1, 2, 0, { tile: 16, speed: 2 }),
    createInterpState(),
    0,
  );
}

function snapshotWithProgram(program: unknown[]): SaveSnapshot {
  const snapshot = baseSnapshot();
  snapshot.interp.parallels[FIBER] = {
    key: FIBER,
    pageIndex: 0,
    parallel: true,
    stack: [{ prog: program, pc: 0 }],
    mode: "run",
    since: 0,
    erase: false,
  } as never;
  return snapshot;
}

function screenWaitSnapshot(command: Command): SaveSnapshot {
  const snapshot = baseSnapshot();
  snapshot.interp.main = {
    key: "map/event",
    pageIndex: 0,
    parallel: false,
    stack: [{ prog: compile([command]), pc: 0 }],
    mode: "screenWait",
    since: 0,
    erase: false,
  } as never;
  return snapshot;
}

const NEW_COMMANDS: Command[] = [
  { op: "scrollMap", direction: "left", distance: 3, speed: 4, wait: true },
  {
    op: "showPicture",
    id: 1,
    layer: "pictures",
    variant: "portrait",
    origin: "center",
    x: { variable: "pictureX" },
    y: 24,
    scaleX: -100,
    scaleY: 100,
    opacity: 192,
    blend: "screen",
  },
  {
    op: "movePicture",
    id: 100,
    x: 120,
    y: { variable: "pictureY" },
    scaleX: 125,
    scaleY: 80,
    opacity: 255,
    duration: 1,
    wait: true,
    easing: "easeInOut",
  },
  { op: "rotatePicture", id: 2, speed: -1.5 },
  { op: "tintPicture", id: 3, tone: { r: -255, g: 0, b: 255, gray: 64 }, duration: 0.5 },
  { op: "erasePicture", id: 4 },
  { op: "timer", action: "start", seconds: 30 },
  { op: "timer", action: "read", variable: "secondsLeft" },
  { op: "timer", action: "stop" },
  { op: "inputNumber", variable: "answer", digits: 8 },
  { op: "openMenu" },
  { op: "openSave" },
  { op: "autosave" },
  { op: "gameOver" },
  { op: "returnTitle" },
  { op: "changeName", name: "Alicia" },
  { op: "mapNameDisplay", visible: false },
  { op: "screenBackdrop", layer: "cutscene", variant: "intro", whenModalOpen: "ignore" },
  { op: "if", if: { kind: "timer", op: "<=", seconds: 10 }, then: [] },
];

describe("KRM2 save validation", () => {
  test("accepts every new compiled instruction and timer condition", () => {
    const program = compile(NEW_COMMANDS);
    expect(program.some((ins) => ins.op === "scene" && ins.id === "rpgkit.numberInput")).toBe(true);
    expect(program.filter((ins) => ins.op === "hostAction").map((ins) => ins.action)).toEqual([
      "menu", "save", "autosave", "gameOver", "title",
    ]);
    expect(validateSnapshot(snapshotWithProgram(program))).toBeNull();
  });

  test("accepts a live timer, map-name flag and mid-picture tweens", () => {
    const interp = createInterpState();
    interp.frame = 15;
    interp.sw.timer = { remaining: 345, running: true, expired: false };
    interp.sw.mapNameDisplay = true;

    let screen: ScreenEffectsState | undefined = {};
    showPicture(screen, {
      id: 7,
      layer: "pictures",
      variant: "portrait",
      origin: "center",
      blend: "normal",
      x: 12,
      y: 24,
      scaleX: 100,
      scaleY: 100,
      opacity: 255,
    });
    movePicture(screen, 7, { x: 48, y: 64, scaleX: -125, scaleY: 80, opacity: 128 }, 60, undefined, undefined, "easeOut");
    tintPicture(screen, 7, { r: -64, g: 32, b: 255, gray: 96 }, 45);
    screen.mapNameBanner = { text: "North Road", total: 180, left: 180 };
    for (let i = 0; i < 15; i++) screen = advanceScreenEffects(screen);
    interp.screen = screen;
    interp.main = {
      key: "map/event",
      pageIndex: 0,
      parallel: false,
      stack: [{
        prog: compile([{
          op: "movePicture",
          id: 7,
          x: 48,
          y: 64,
          scaleX: -125,
          scaleY: 80,
          opacity: 128,
          duration: 1,
          wait: true,
          easing: "easeOut",
        }]),
        pc: 0,
      }],
      mode: "screenWait",
      since: 0,
      erase: false,
    } as never;

    const snapshot = createSnapshot(
      "map",
      initialMovement(1, 2, 0, { tile: 16, speed: 2 }),
      interp,
      0,
    );
    expect(validateSnapshot(snapshot)).toBeNull();
  });

  test("accepts all three new waited screen instructions", () => {
    const commands: Command[] = [
      { op: "scrollMap", direction: "down", distance: 2, speed: 3, wait: true },
      { op: "movePicture", id: 1, x: 0, y: 0, scaleX: 100, scaleY: 100, opacity: 255, duration: 1, wait: true },
      { op: "tintPicture", id: 1, tone: { r: 0, g: 0, b: 0, gray: 128 }, duration: 1, wait: true },
    ];
    for (const command of commands) {
      expect(validateSnapshot(screenWaitSnapshot(command)), command.op).toBeNull();
    }
  });

  test("rejects malformed timer flags, banners, pictures and tweens", () => {
    const valid = baseSnapshot() as any;
    valid.interp.sw.timer = { remaining: 60, running: true, expired: false };
    valid.interp.sw.mapNameDisplay = true;
    valid.interp.screen = {
      pictures: {
        "1": {
          id: 1,
          layer: "pictures",
          variant: "portrait",
          origin: "topLeft",
          blend: "add",
          transform: { x: 0, y: 0, scaleX: 100, scaleY: 100, opacity: 255 },
          tone: { r: 0, g: 0, b: 0, gray: 0 },
          rotation: 0,
          rotationSpeed: 0,
          move: {
            from: { x: 0, y: 0, scaleX: 100, scaleY: 100, opacity: 255 },
            to: { x: 20, y: 30, scaleX: 90, scaleY: 110, opacity: 128 },
            total: 30,
            left: 15,
            easing: "linear",
          },
          tint: {
            from: { r: 0, g: 0, b: 0, gray: 0 },
            to: { r: -20, g: 30, b: 40, gray: 50 },
            total: 20,
            left: 10,
          },
        },
      },
      mapNameBanner: { text: "North Road", total: 180, left: 90 },
    };
    expect(validateSnapshot(valid)).toBeNull();

    const cases: Array<[string, (snapshot: any) => void, string]> = [
      ["timer remainder", (s) => { s.interp.sw.timer.remaining = -1; }, ".timer.remaining"],
      ["timer running", (s) => { s.interp.sw.timer.running = false; }, ".timer.running"],
      ["timer expiry", (s) => { s.interp.sw.timer.expired = true; }, ".timer.expired"],
      ["map-name flag", (s) => { s.interp.sw.mapNameDisplay = false; }, ".mapNameDisplay"],
      ["picture key", (s) => { s.interp.screen.pictures["1"].id = 2; }, ".pictures.1"],
      ["picture id", (s) => { s.interp.screen.pictures["1"].id = 101; }, ".pictures.1.id"],
      ["picture scale", (s) => { s.interp.screen.pictures["1"].transform.scaleX = 2001; }, ".transform.scaleX"],
      ["picture opacity", (s) => { s.interp.screen.pictures["1"].transform.opacity = 256; }, ".transform.opacity"],
      ["picture tone", (s) => { s.interp.screen.pictures["1"].tone.r = -256; }, ".tone.r"],
      ["move remainder", (s) => { s.interp.screen.pictures["1"].move.left = 31; }, ".move"],
      ["move easing", (s) => { s.interp.screen.pictures["1"].move.easing = "bounce"; }, ".move.easing"],
      ["tint total", (s) => { s.interp.screen.pictures["1"].tint.total = 0; }, ".tint"],
      ["rotation", (s) => { s.interp.screen.pictures["1"].rotation = 360; }, ".rotation"],
      ["banner text", (s) => { s.interp.screen.mapNameBanner.text = ""; }, ".mapNameBanner.text"],
      ["banner remainder", (s) => { s.interp.screen.mapNameBanner.left = 181; }, ".mapNameBanner"],
    ];
    for (const [label, mutate, expectedPath] of cases) {
      const snapshot = structuredClone(valid);
      mutate(snapshot);
      expect(validateSnapshot(snapshot), label).toContain(expectedPath);
    }
  });

  test("rejects malformed new bytecode and undrained host actions", () => {
    const badInstructions: Array<[string, Record<string, unknown>, string]> = [
      ["scroll direction", { op: "scrollMap", direction: "north", distance: 1, frames: 30, wait: true }, ".direction"],
      ["show id", {
        op: "showPicture", id: 0, layer: "pictures", variant: "portrait", origin: "topLeft",
        x: 0, y: 0, scaleX: 100, scaleY: 100, opacity: 255, blend: "normal",
      }, ".id"],
      ["move frames", {
        op: "movePicture", id: 1, origin: null, x: 0, y: 0, scaleX: 100, scaleY: 100,
        opacity: 255, blend: null, frames: -1, wait: true, easing: "linear",
      }, ".frames"],
      ["rotate speed", { op: "rotatePicture", id: 1, speed: Number.POSITIVE_INFINITY }, ".speed"],
      ["tint tone", {
        op: "tintPicture", id: 1, tone: { r: 0, g: 0, b: 0, gray: 256 }, frames: 1, wait: false,
      }, ".tone.gray"],
      ["erase id", { op: "erasePicture", id: 101 }, ".id"],
      ["timer action", { op: "timer", action: "pause" }, ".action"],
      ["host action", { op: "hostAction", action: "quit" }, ".action"],
      ["empty name", { op: "changeName", name: "" }, ".name"],
      ["map-name visible", { op: "mapNameDisplay", visible: "yes" }, ".visible"],
      ["backdrop modal policy", { op: "screenBackdrop", layer: "cutscene", variant: "intro", whenModalOpen: "replace" }, ".whenModalOpen"],
    ];
    for (const [label, instruction, expectedPath] of badInstructions) {
      expect(validateSnapshot(snapshotWithProgram([instruction])), label).toContain(expectedPath);
    }

    const snapshot = baseSnapshot();
    snapshot.interp.hostActions = ["save"];
    expect(validateSnapshot(snapshot)).toBe("state.interp.hostActions: host actions must drain before save");
  });
});
