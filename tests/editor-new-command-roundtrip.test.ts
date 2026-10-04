import { describe, expect, test } from "bun:test";
import { defaultCommand, type EditableCommandOp } from "../editor/engine/commands.ts";
import { loadProject, serializeProject } from "../editor/engine/document.ts";
import { editCommandField } from "../editor/engine/event-fields.ts";
import { createExtensionRuntime } from "../src/engine/extensions.ts";
import {
  compile,
  createInterpState,
  createWorld,
  stepInterp,
  type InterpInput,
} from "../src/engine/interpreter.ts";
import type { Command, Project } from "../src/engine/types.ts";

type Edit = readonly [field: string, value: string];

const NEWER_COMMAND_CASES: readonly {
  readonly op: EditableCommandOp;
  readonly edits: readonly Edit[];
}[] = [
  { op: "moveControl", edits: [["target", "player"], ["control.kind", "speed"], ["control.value", "5"]] },
  { op: "appearance", edits: [["target", "player"], ["sprite", "hero"], ["opacity", "128"], ["saveDefault", "true"]] },
  { op: "layer", edits: [["layer", "weather"], ["visible", "false"], ["variant", "rain"]] },
  { op: "tileProperty", edits: [["x", "1"], ["y", "1"], ["passage", "block"], ["enter", "left,up"]] },
  { op: "screenFade", edits: [["direction", "in"], ["duration", "0.1"], ["color", "1,2,3,255"]] },
  { op: "screenTint", edits: [["layer", "night"], ["color.r", "12"], ["duration", "0.1"]] },
  { op: "screenFlash", edits: [["intensity", "128"], ["duration", "0.1"]] },
  { op: "screenShake", edits: [["strength", "4"], ["speed", "2.5"], ["duration", "0.1"]] },
  { op: "camera", edits: [["target", "tile:2,2"], ["duration", "0.1"]] },
  { op: "scrollMap", edits: [["direction", "right"], ["distance", "2.5"], ["speed", "5"]] },
  { op: "balloon", edits: [["target", "player"], ["icon", "spark"], ["duration", "0.1"], ["wait", "true"]] },
  { op: "screenBackdrop", edits: [["layer", "cutscene"], ["variant", "dusk"]] },
  { op: "showPicture", edits: [["id", "2"], ["layer", "pictures"], ["variant", "portrait"], ["x", "$picture-x"], ["scaleX", "-100"], ["opacity", "128.5"]] },
  { op: "movePicture", edits: [["id", "2"], ["x", "12.5"], ["y", "$picture-y"], ["duration", "0.1"], ["easing", "easeOut"]] },
  { op: "rotatePicture", edits: [["id", "2"], ["speed", "-1.5"]] },
  { op: "tintPicture", edits: [["id", "2"], ["tone.r", "-64"], ["tone.gray", "32"], ["duration", "0.1"]] },
  { op: "erasePicture", edits: [["id", "2"]] },
  { op: "timer", edits: [["seconds", "12.5"]] },
  { op: "inputNumber", edits: [["variable", "answer"], ["digits", "4"]] },
  { op: "openMenu", edits: [] },
  { op: "openSave", edits: [] },
  { op: "autosave", edits: [] },
  { op: "gameOver", edits: [] },
  { op: "returnTitle", edits: [] },
  { op: "changeName", edits: [["name", "Terra"]] },
  { op: "mapNameDisplay", edits: [["visible", "false"]] },
  { op: "mapAnim", edits: [["id", "spark-1"], ["anim", "spark"], ["placement", "target"], ["target", "player"], ["follow", "false"], ["layer", "below"]] },
  { op: "stopAnim", edits: [["selector", "anim"], ["anim", "spark"]] },
  { op: "shop", edits: [["id", "field-shop"], ["goods", '[{"item":"potion","price":7}]'], ["sellList", "hide"]] },
  { op: "battle", edits: [["setup", '{"enemy":"slime","level":3}']] },
  { op: "ext", edits: [["call", "game.command"], ["args", '{"chapter":2}']] },
  { op: "extChoice", edits: [["call", "game.choice"], ["args", '{"party":true}'], ["prompt", "Choose"], ["cancel", "true"], ["write", '{"index":"choice.index","key":"choice.key"}']] },
  { op: "playBgm", edits: [["id", "field"], ["volume", "70"], ["pitch", "90"]] },
  { op: "fadeoutBgm", edits: [["duration", "0.1"]] },
  { op: "stopBgm", edits: [] },
  { op: "pauseBgm", edits: [] },
  { op: "resumeBgm", edits: [] },
  { op: "playBgs", edits: [["id", "rain"], ["volume", "65"]] },
  { op: "fadeoutBgs", edits: [["duration", "0.1"]] },
  { op: "playMe", edits: [["id", "victory"], ["duration", "0.1"]] },
  { op: "playSe", edits: [["id", "door"], ["pitch", "120"]] },
  { op: "stopSe", edits: [] },
  { op: "saveBgm", edits: [] },
  { op: "replayBgm", edits: [] },
  { op: "label", edits: [["name", "checkpoint"]] },
  { op: "jumpLabel", edits: [["name", "checkpoint"]] },
  { op: "selectItem", edits: [["variable", "pick"], ["itemType", "key"]] },
  { op: "menuAccess", edits: [["enabled", "false"]] },
  { op: "saveAccess", edits: [["enabled", "false"]] },
  { op: "locationInfo", edits: [["variable", "cell"], ["x", "3"], ["y", "4"], ["kind", "region"], ["layer", "1"]] },
] as const;

const INPUT: InterpInput = {
  confirmEdge: true,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
  playerCell: { x: 1, y: 1 },
  prevCell: { x: 1, y: 1 },
  facing: 2,
};

function editedCommand(op: EditableCommandOp, edits: readonly Edit[]): Command {
  let command: Command = defaultCommand(op);
  for (const [field, value] of edits) {
    const edited = editCommandField(command, field, value);
    if (!edited.ok) throw new Error(`${op}.${field}: ${edited.error}`);
    command = edited.value;
  }
  return command;
}

function projectWith(command: Command): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Editor command roundtrip",
    tileSize: 16,
    start: { map: "map", x: 1, y: 1, dir: "up" },
    sheets: [{ id: "base", pak: "chunks", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [{ id: "potion", name: "Potion", sprite: "base.0", price: 10 }],
    sprites: { hero: { kind: "image", src: "sprite:hero" } },
    animations: [{ id: "spark", sheet: "spark-sheet", count: 2, frameDuration: 0.05 }],
    audio: {
      field: "audio:wav.field",
      rain: "audio:wav.rain",
      victory: "audio:wav.victory",
      door: "audio:wav.door",
    },
    commonEvents: [{ id: "common", trigger: "none", commands: [] }],
    maps: [{
      id: "map",
      name: "Map",
      width: 4,
      height: 4,
      sheets: ["base"],
      ground: new Array(16).fill("base.0"),
      events: [{
        id: "source",
        x: 1,
        y: 0,
        pages: [{ trigger: "action", commands: [command] }],
      }],
    }],
  };
}

describe("newer editor commands roundtrip through the runtime", () => {
  test("the coverage table names each formerly read-only command exactly once", () => {
    expect(NEWER_COMMAND_CASES.map(({ op }) => op)).toEqual([
      "moveControl", "appearance", "layer", "tileProperty",
      "screenFade", "screenTint", "screenFlash", "screenShake", "camera", "scrollMap", "balloon", "screenBackdrop",
      "showPicture", "movePicture", "rotatePicture", "tintPicture", "erasePicture", "timer", "inputNumber",
      "openMenu", "openSave", "autosave", "gameOver", "returnTitle", "changeName", "mapNameDisplay",
      "mapAnim", "stopAnim", "shop", "battle", "ext", "extChoice",
      "playBgm", "fadeoutBgm", "stopBgm", "pauseBgm", "resumeBgm",
      "playBgs", "fadeoutBgs", "playMe", "playSe", "stopSe", "saveBgm", "replayBgm",
      "label", "jumpLabel", "selectItem", "menuAccess", "saveAccess", "locationInfo",
    ]);
    expect(new Set(NEWER_COMMAND_CASES.map(({ op }) => op)).size).toBe(NEWER_COMMAND_CASES.length);
  });

  for (const entry of NEWER_COMMAND_CASES) {
    test(`${entry.op}: create, edit, export, validate, compile, and execute`, () => {
      const authored = editedCommand(entry.op, entry.edits);
      const exported = serializeProject(projectWith(authored));
      const loaded = loadProject(exported);
      expect(loaded.errors, entry.op).toEqual([]);

      const command = loaded.project.maps[0]!.events![0]!.pages[0]!.commands[0]!;
      expect(command).toEqual(authored);
      const compiledOp = ["inputNumber", "selectItem"].includes(entry.op)
        ? "scene"
        : ["openMenu", "openSave", "autosave", "gameOver", "returnTitle"].includes(entry.op)
          ? "hostAction"
          : entry.op;
      expect<string | undefined>(compile([command])[0]?.op).toBe(compiledOp);

      let started = false;
      let extensionCalls = 0;
      const extensions = createExtensionRuntime({
        initial: null,
        commands: {
          "game.command": () => {
            extensionCalls++;
          },
        },
        choices: {
          "game.choice": {
            options: () => [{ key: "first", label: "First" }],
          },
        },
      });
      const world = createWorld(
        loaded.project.maps[0]!,
        loaded.project.commonEvents,
        60,
        {
          animations: loaded.project.animations,
          extensions,
          items: loaded.project.items,
          onFiberStart: () => {
            started = true;
          },
        },
      );
      const initialState = createInterpState();
      initialState.sw.variables["picture-x"] = 3;
      initialState.sw.variables["picture-y"] = 4;
      const state = stepInterp(world, initialState, INPUT);
      expect(started, entry.op).toBe(true);
      expect(state.error, entry.op).toBeUndefined();
      expect(state.frame, entry.op).toBe(1);
      if (entry.op === "ext") expect(extensionCalls).toBe(1);
      if (entry.op === "extChoice") expect(state.modal?.kind).toBe("choices");
      if (entry.op === "shop") expect(state.modal?.kind).toBe("shop");
      if (entry.op === "battle") expect(state.pendingBattles).toHaveLength(1);
      if (entry.op === "inputNumber") expect(state.pendingScenes?.[0]?.id).toBe("rpgkit.numberInput");
      if (entry.op === "timer") expect(state.sw.timer?.running).toBe(true);
      if (entry.op === "openMenu") expect(state.hostActions).toEqual(["menu"]);
      if (entry.op === "openSave") expect(state.hostActions).toEqual(["save"]);
      if (entry.op === "autosave") expect(state.hostActions).toEqual(["autosave"]);
      if (entry.op === "gameOver") expect(state.hostActions).toEqual(["gameOver"]);
      if (entry.op === "returnTitle") expect(state.hostActions).toEqual(["title"]);
      if (entry.op === "changeName") expect(state.sw.playerName).toBe("Terra");
      if (entry.op === "mapNameDisplay") expect(state.sw.mapNameDisplay).toBeUndefined();
    });
  }
});
