import { describe, expect, test } from "bun:test";
import {
  addPageCondition,
  commandFields,
  commandInspectorRows,
  conditionFields,
  deletePageCondition,
  editCommandField,
  editPageConditionField,
  editPageField,
  editPageRouteField,
  nextFieldValue,
  pageFieldDescriptors,
  pageRouteFieldDescriptors,
} from "../editor/engine/event-fields.ts";
import { CONDITION_KINDS, EDITABLE_COMMAND_OPS, defaultCommand, defaultCondition } from "../editor/engine/commands.ts";
import { eventEditorResources } from "../editor/engine/event-resources.ts";
import { validateProject } from "../editor/engine/document.ts";
import type { Command, Condition, Page, Project } from "../src/engine/types.ts";

function edit(command: Command, key: string, value: string): Command {
  const result = editCommandField(command, key, value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function projectWith(commands: Command[], page: Partial<Page> = {}): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Field editor",
    tileSize: 16,
    start: { map: "map", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "town", pak: "chunks", cols: 1, rows: 1 }],
    items: [
      { id: "item", name: "Item", sprite: "town.0" },
      { id: "potion", name: "Potion", sprite: "town.0" },
    ],
    sprites: {
      hero: { kind: "image", src: "sprite:hero" },
      npc: { kind: "image", src: "sprite:npc" },
    },
    animations: [
      { id: "animation", sheet: "animation-sheet", count: 1, frameDuration: 0.1 },
      { id: "spark", sheet: "spark-sheet", count: 2, frameDuration: 0.1 },
    ],
    audio: {
      audio: "audio:wav.audio",
      door: "audio:wav.door",
      field: "audio:wav.field",
      rain: "audio:wav.rain",
      sound: "audio:wav.sound",
      victory: "audio:wav.victory",
    },
    commonEvents: [{ id: "ce", trigger: "none", commands: [] }],
    maps: [{
      id: "map", name: "Map", width: 2, height: 2, sheets: ["town"],
      ground: ["town.0", "town.0", "town.0", "town.0"],
      events: [{ id: "event", x: 0, y: 0, pages: [{ trigger: "action", commands, ...page }] }],
    }],
  };
}

const NEWER_COMMAND_FIELDS = [
  ["moveControl", ["target", "control.kind"]],
  ["appearance", ["target", "sprite", "opacity", "visible", "saveDefault"]],
  ["layer", ["layer", "visible", "variant"]],
  ["tileProperty", ["x", "y", "passage", "enter", "exit"]],
  ["screenFade", ["direction", "duration", "color", "wait"]],
  ["screenTint", ["layer", "color.r", "color.g", "color.b", "color.a", "duration", "wait"]],
  ["screenFlash", ["color.r", "color.g", "color.b", "color.a", "intensity", "duration", "wait"]],
  ["screenShake", ["strength", "speed", "duration", "wait"]],
  ["camera", ["target", "duration", "wait"]],
  ["scrollMap", ["direction", "distance", "speed", "wait"]],
  ["balloon", ["target", "icon", "duration", "wait"]],
  ["screenBackdrop", ["layer", "variant", "whenModalOpen"]],
  ["showPicture", ["id", "layer", "variant", "origin", "x", "y", "scaleX", "scaleY", "opacity", "blend"]],
  ["movePicture", ["id", "origin", "x", "y", "scaleX", "scaleY", "opacity", "blend", "duration", "wait", "easing"]],
  ["rotatePicture", ["id", "speed"]],
  ["tintPicture", ["id", "tone.r", "tone.g", "tone.b", "tone.gray", "duration", "wait"]],
  ["erasePicture", ["id"]],
  ["timer", ["action", "seconds"]],
  ["inputNumber", ["variable", "digits"]],
  ["openMenu", []],
  ["openSave", []],
  ["autosave", []],
  ["gameOver", []],
  ["returnTitle", []],
  ["changeName", ["name"]],
  ["mapNameDisplay", ["visible"]],
  ["mapAnim", ["id", "anim", "placement", "x", "y", "follow", "layer", "loop", "wait"]],
  ["stopAnim", ["selector"]],
  ["shop", ["id", "goods", "sell", "sellList"]],
  ["battle", ["setup"]],
  ["ext", ["call", "args"]],
  ["extChoice", ["call", "args", "prompt", "cancel", "write"]],
  ["playBgm", ["id", "volume", "pitch"]],
  ["fadeoutBgm", ["duration"]],
  ["stopBgm", []],
  ["pauseBgm", []],
  ["resumeBgm", []],
  ["playBgs", ["id", "volume", "pitch"]],
  ["fadeoutBgs", ["duration"]],
  ["playMe", ["id", "duration", "volume", "pitch"]],
  ["playSe", ["id", "volume", "pitch"]],
  ["stopSe", []],
  ["saveBgm", []],
  ["replayBgm", []],
  ["label", ["name"]],
  ["jumpLabel", ["name"]],
  ["selectItem", ["variable", "itemType"]],
  ["menuAccess", ["enabled"]],
  ["saveAccess", ["enabled"]],
  ["locationInfo", ["variable", "x", "y", "kind", "layer"]],
] as const;

describe("event inspector command fields", () => {
  test("describes every owned command, including all 50 newer operations", () => {
    expect(NEWER_COMMAND_FIELDS).toHaveLength(50);
    for (const [op, keys] of NEWER_COMMAND_FIELDS) {
      const command = defaultCommand(op);
      expect(commandFields(command).map((entry) => entry.key), op).toEqual([...keys]);
      const [row] = commandInspectorRows([command]);
      expect({ supported: row!.supported, readOnly: row!.readOnly }, op)
        .toEqual({ supported: true, readOnly: false });
    }

    const editable = EDITABLE_COMMAND_OPS.map((op) => defaultCommand(op));
    expect(commandInspectorRows(editable).every((row) => row.supported && !row.readOnly)).toBe(true);
    expect(validateProject(projectWith(editable))).toEqual([]);
    expect(commandFields(defaultCommand("choices")).map((entry) => entry.key)).toEqual([
      "prompt", "optionCount", "option:0", "option:0.icon", "option:1", "option:1.icon", "cancel",
    ]);
  });

  test("loop and break have no fields; text tokens survive field round trips", () => {
    for (const op of ["loop", "break"] as const) {
      const command = defaultCommand(op);
      expect(commandFields(command), op).toEqual([]);
      const [row] = commandInspectorRows([command]);
      expect({ supported: row!.supported, readOnly: row!.readOnly }, op).toEqual({ supported: true, readOnly: false });
      const result = editCommandField(command, "commands", "[]");
      expect(result.ok, op).toBe(false);
    }
    const lines = "Gold: {v:gold} for {name}\n{v:} {v:a.b-c} {x}";
    const text = edit(defaultCommand("text"), "lines", lines);
    expect(text).toEqual({ op: "text", lines: ["Gold: {v:gold} for {name}", "{v:} {v:a.b-c} {x}"] });
    expect(commandFields(text)[0]!.value).toBe(lines);
    let choices = edit(defaultCommand("choices"), "prompt", "Pay {v:price}?");
    choices = edit(choices, "option:0", "Yes ({v:gold} left)");
    expect(choices).toMatchObject({ prompt: "Pay {v:price}?", options: [{ text: "Yes ({v:gold} left)" }, { text: "Option 2" }] });
    // The 52-character limit measures the raw, unexpanded text.
    expect(editCommandField(defaultCommand("text"), "lines", `${"x".repeat(46)}{v:id}`).ok).toBe(true);
    expect(editCommandField(defaultCommand("text"), "lines", `${"x".repeat(47)}{v:id}`).ok).toBe(false);
    const project = projectWith([text, choices, { op: "loop", commands: [{ op: "break" }] }]);
    project.system = { textVariables: true };
    expect(validateProject(project)).toEqual([]);
  });

  test("edits text, choices, switches and both variable operand forms", () => {
    expect(edit(defaultCommand("text"), "lines", "Hello\ntraveller")).toEqual({ op: "text", lines: ["Hello", "traveller"] });
    let choices = edit(defaultCommand("choices"), "optionCount", "3");
    choices = edit(choices, "option:2", "Leave");
    choices = edit(choices, "cancel", "true");
    expect(choices).toMatchObject({ options: [{ text: "Option 1" }, { text: "Option 2" }, { text: "Leave" }], cancel: { commands: [] } });
    expect(edit(defaultCommand("switch"), "value", "false")).toEqual({ op: "switch", id: "switch", value: false });
    let variable = edit(defaultCommand("variable"), "mode", "random");
    variable = edit(variable, "min", "2");
    variable = edit(variable, "max", "9");
    expect(variable).toMatchObject({ set: { op: "random", min: 2, max: 9 } });
    variable = edit(variable, "mode", "mul:variable");
    variable = edit(variable, "from", "factor");
    expect(variable).toMatchObject({ set: { op: "mul", from: "factor" } });
  });

  test("edits if conditions, transfer variable operands, and basic movement routes", () => {
    let conditional = edit(defaultCommand("if"), "if.kind", "gold");
    conditional = edit(conditional, "if.amount", "12");
    conditional = edit(conditional, "else", "true");
    expect(conditional).toEqual({ op: "if", if: { kind: "gold", amount: 12 }, then: [], else: [] });

    let transfer = edit(defaultCommand("transfer"), "map", "$destination");
    transfer = edit(transfer, "x", "$door-x");
    transfer = edit(transfer, "y", "7");
    transfer = edit(transfer, "dir", "left");
    expect(transfer).toMatchObject({ map: { variable: "destination" }, x: { variable: "door-x" }, y: 7, dir: "left" });

    let route = edit(defaultCommand("moveRoute"), "target", "event:guard");
    route = edit(route, "steps", "moveUp,faceLeft,wait");
    route = edit(route, "repeat", "true");
    expect(route).toMatchObject({ target: { event: "guard" }, route: { steps: ["moveUp", "faceLeft", "wait"], repeat: true } });
  });

  test("edits the remaining parameterized command forms into a valid project", () => {
    const commands: Command[] = [
      edit(defaultCommand("selfSwitch"), "key", "D"),
      edit(defaultCommand("wait"), "seconds", "0.25"),
      edit(edit(defaultCommand("gold"), "set", "sub"), "amount", "4"),
      edit(edit(edit(defaultCommand("item"), "item", "potion"), "set", "add"), "count", "2"),
      edit(edit(edit(defaultCommand("se"), "name", "door-open"), "volume", "70"), "pitch", "110"),
      edit(defaultCommand("common"), "id", "ce"),
      edit(edit(edit(defaultCommand("place"), "target", "event:guard"), "x", "1"), "y", "1"),
      defaultCommand("erase"), defaultCommand("exit"), defaultCommand("lockInput"), defaultCommand("unlockInput"),
    ];
    expect(validateProject(projectWith(commands))).toEqual([]);
  });

  test("successfully edits every parameterized newer command and keeps the project valid", () => {
    const cases: Array<{
      op: (typeof NEWER_COMMAND_FIELDS)[number][0];
      field: string;
      raw: string;
      expected: Record<string, unknown>;
    }> = [
      { op: "moveControl", field: "control.kind", raw: "speed", expected: { control: { kind: "speed", value: 4 } } },
      { op: "appearance", field: "opacity", raw: "128", expected: { opacity: 128 } },
      { op: "layer", field: "variant", raw: "mist", expected: { variant: "mist" } },
      { op: "tileProperty", field: "enter", raw: "left,up", expected: { enter: ["left", "up"] } },
      { op: "screenFade", field: "color", raw: "1,2,3,4", expected: { color: { r: 1, g: 2, b: 3, a: 4 } } },
      { op: "screenTint", field: "color.r", raw: "64", expected: { color: { r: 64 } } },
      { op: "screenFlash", field: "intensity", raw: "128", expected: { intensity: 128 } },
      { op: "screenShake", field: "speed", raw: "2.5", expected: { speed: 2.5 } },
      { op: "camera", field: "target", raw: "tile:1,2", expected: { target: { x: 1, y: 2 } } },
      { op: "scrollMap", field: "speed", raw: "6", expected: { speed: 6 } },
      { op: "balloon", field: "icon", raw: "spark", expected: { icon: "spark" } },
      { op: "screenBackdrop", field: "whenModalOpen", raw: "ignore", expected: { whenModalOpen: "ignore" } },
      { op: "showPicture", field: "x", raw: "$picture-x", expected: { x: { variable: "picture-x" } } },
      { op: "movePicture", field: "scaleX", raw: "-50", expected: { scaleX: -50 } },
      { op: "rotatePicture", field: "speed", raw: "-1.5", expected: { speed: -1.5 } },
      { op: "tintPicture", field: "tone.r", raw: "-128", expected: { tone: { r: -128 } } },
      { op: "erasePicture", field: "id", raw: "100", expected: { id: 100 } },
      { op: "timer", field: "action", raw: "read", expected: { action: "read", variable: "variable" } },
      { op: "inputNumber", field: "digits", raw: "8", expected: { digits: 8 } },
      { op: "changeName", field: "name", raw: "Terra", expected: { name: "Terra" } },
      { op: "mapNameDisplay", field: "visible", raw: "false", expected: { visible: false } },
      { op: "mapAnim", field: "placement", raw: "target", expected: { target: "player" } },
      { op: "stopAnim", field: "selector", raw: "id", expected: { id: "animation" } },
      { op: "shop", field: "goods", raw: '[{"item":"potion","price":7}]', expected: { goods: [{ item: "potion", price: 7 }] } },
      { op: "battle", field: "setup", raw: '{"enemy":"slime"}', expected: { setup: { enemy: "slime" } } },
      { op: "ext", field: "args", raw: '{"chapter":2}', expected: { args: { chapter: 2 } } },
      { op: "extChoice", field: "write", raw: '{"index":"choice.index"}', expected: { write: { index: "choice.index" } } },
      { op: "playBgm", field: "volume", raw: "70", expected: { volume: 70 } },
      { op: "fadeoutBgm", field: "duration", raw: "1.5", expected: { duration: 1.5 } },
      { op: "playBgs", field: "id", raw: "rain", expected: { id: "rain" } },
      { op: "fadeoutBgs", field: "duration", raw: "0.5", expected: { duration: 0.5 } },
      { op: "playMe", field: "duration", raw: "4", expected: { duration: 4 } },
      { op: "playSe", field: "pitch", raw: "120", expected: { pitch: 120 } },
      { op: "selectItem", field: "itemType", raw: "key", expected: { itemType: "key" } },
      { op: "selectItem", field: "variable", raw: "picked", expected: { variable: "picked" } },
      { op: "locationInfo", field: "x", raw: "$coordX", expected: { x: { variable: "coordX" } } },
      { op: "locationInfo", field: "y", raw: "$coordY", expected: { y: { variable: "coordY" } } },
      { op: "locationInfo", field: "layer", raw: "3", expected: { layer: 3 } },
      { op: "locationInfo", field: "kind", raw: "region", expected: { kind: "region" } },
    ];

    const edited: Command[] = [];
    for (const entry of cases) {
      const result = editCommandField(defaultCommand(entry.op), entry.field, entry.raw);
      expect(result.ok, `${entry.op}.${entry.field}`).toBe(true);
      if (!result.ok) continue;
      expect(result.value, `${entry.op}.${entry.field}`).toMatchObject(entry.expected);
      edited.push(result.value);
    }
    edited.push(
      defaultCommand("stopBgm"), defaultCommand("pauseBgm"), defaultCommand("resumeBgm"),
      defaultCommand("saveBgm"), defaultCommand("replayBgm"), defaultCommand("openMenu"),
      defaultCommand("openSave"), defaultCommand("autosave"), defaultCommand("gameOver"), defaultCommand("returnTitle"),
    );
    expect(validateProject(projectWith(edited))).toEqual([]);
  });

  test("timer action changes rebuild the discriminated payload and its fields", () => {
    let timer: Command = defaultCommand("timer");
    expect(commandFields(timer).map((entry) => entry.key)).toEqual(["action", "seconds"]);
    timer = edit(timer, "action", "stop");
    expect(timer).toEqual({ op: "timer", action: "stop" });
    expect(commandFields(timer).map((entry) => entry.key)).toEqual(["action"]);
    timer = edit(timer, "action", "read");
    expect(timer).toEqual({ op: "timer", action: "read", variable: "variable" });
    expect(commandFields(timer).map((entry) => entry.key)).toEqual(["action", "variable"]);
    expect(edit(timer, "variable", "timer-left")).toEqual({ op: "timer", action: "read", variable: "timer-left" });
  });

  test("locationInfo variable coordinates display, edit and retain", () => {
    // A variable coordinate shows as $id (not 0), edits to $id create a
    // variable reference, and the reference survives a field round trip.
    let command: Command = { op: "locationInfo", variable: "located", x: { variable: "coordX" }, y: 4, kind: "region" };
    const fields = () => Object.fromEntries(commandFields(command).map((entry) => [entry.key, entry.value]));
    expect(fields()).toMatchObject({ x: "$coordX", y: 4 });
    command = edit(command, "y", "$coordY");
    expect(command).toMatchObject({ y: { variable: "coordY" } });
    expect(fields()).toMatchObject({ x: "$coordX", y: "$coordY" });
    // Back to a literal.
    command = edit(command, "x", "9");
    expect(command).toMatchObject({ x: 9 });
    expect(validateProject(projectWith([command]))).toEqual([]);
  });

  test("selectItem type and variable are editable", () => {
    let command: Command = { op: "selectItem", variable: "pick", itemType: "regular" };
    command = edit(command, "itemType", "hiddenB");
    expect(command).toMatchObject({ itemType: "hiddenB" });
    command = edit(command, "variable", "chosen");
    expect(command).toMatchObject({ variable: "chosen" });
    expect(validateProject(projectWith([command]))).toEqual([]);
  });

  test("rejects invalid JSON, ranges, enums, and schema-breaking edits", () => {
    const cases: Array<{ name: string; command: Command; field: string; raw: string }> = [
      { name: "move speed", command: { op: "moveControl", target: "this", control: { kind: "speed", value: 4 } }, field: "control.value", raw: "7" },
      { name: "appearance range", command: defaultCommand("appearance"), field: "opacity", raw: "256" },
      { name: "appearance save default invariant", command: defaultCommand("appearance"), field: "saveDefault", raw: "true" },
      { name: "layer required alternative", command: defaultCommand("layer"), field: "visible", raw: "(unset)" },
      { name: "tile coordinate", command: defaultCommand("tileProperty"), field: "x", raw: "-1" },
      { name: "tile duplicate directions", command: defaultCommand("tileProperty"), field: "enter", raw: "left,left" },
      { name: "fade color range", command: defaultCommand("screenFade"), field: "color", raw: "0,0,0,256" },
      { name: "tint channel", command: defaultCommand("screenTint"), field: "color.a", raw: "-1" },
      { name: "flash intensity", command: defaultCommand("screenFlash"), field: "intensity", raw: "256" },
      { name: "shake strength", command: defaultCommand("screenShake"), field: "strength", raw: "-1" },
      { name: "camera target", command: defaultCommand("camera"), field: "target", raw: "tile:-1,2" },
      { name: "scroll speed", command: defaultCommand("scrollMap"), field: "speed", raw: "7" },
      { name: "waited balloon invariant", command: defaultCommand("balloon"), field: "wait", raw: "true" },
      { name: "backdrop layer", command: defaultCommand("screenBackdrop"), field: "layer", raw: "" },
      { name: "backdrop modal policy", command: defaultCommand("screenBackdrop"), field: "whenModalOpen", raw: "replace" },
      { name: "show picture id", command: defaultCommand("showPicture"), field: "id", raw: "101" },
      { name: "show picture scale", command: defaultCommand("showPicture"), field: "scaleX", raw: "-2001" },
      { name: "move picture opacity", command: defaultCommand("movePicture"), field: "opacity", raw: "256" },
      { name: "move picture easing", command: defaultCommand("movePicture"), field: "easing", raw: "bounce" },
      { name: "picture tone RGB", command: defaultCommand("tintPicture"), field: "tone.r", raw: "-256" },
      { name: "picture tone gray", command: defaultCommand("tintPicture"), field: "tone.gray", raw: "256" },
      { name: "timer seconds", command: defaultCommand("timer"), field: "seconds", raw: "-1" },
      { name: "input digits", command: defaultCommand("inputNumber"), field: "digits", raw: "9" },
      { name: "empty player name", command: defaultCommand("changeName"), field: "name", raw: "" },
      { name: "map name display boolean", command: defaultCommand("mapNameDisplay"), field: "visible", raw: "maybe" },
      { name: "shop JSON", command: defaultCommand("shop"), field: "goods", raw: "{" },
      { name: "shop nonempty goods", command: defaultCommand("shop"), field: "goods", raw: "[]" },
      { name: "map animation coordinate", command: defaultCommand("mapAnim"), field: "x", raw: "-1" },
      { name: "map animation target", command: { ...defaultCommand("mapAnim"), target: "player", x: undefined, y: undefined } as Command, field: "target", raw: "this" },
      { name: "stop animation id", command: { op: "stopAnim", id: "animation" }, field: "id", raw: "bad id" },
      { name: "extension call", command: defaultCommand("ext"), field: "call", raw: "unnamespaced" },
      { name: "extension JSON", command: defaultCommand("ext"), field: "args", raw: "[" },
      { name: "choice write object", command: defaultCommand("extChoice"), field: "write", raw: "[]" },
      { name: "choice write distinct", command: defaultCommand("extChoice"), field: "write", raw: '{"index":"v","key":"v"}' },
      { name: "battle JSON", command: defaultCommand("battle"), field: "setup", raw: "{" },
      { name: "BGM volume", command: defaultCommand("playBgm"), field: "volume", raw: "101" },
      { name: "BGS pitch", command: defaultCommand("playBgs"), field: "pitch", raw: "49" },
      { name: "ME duration", command: defaultCommand("playMe"), field: "duration", raw: "-1" },
      { name: "SE id", command: defaultCommand("playSe"), field: "id", raw: "" },
      { name: "fade duration", command: defaultCommand("fadeoutBgm"), field: "duration", raw: "-1" },
    ];

    for (const entry of cases) {
      expect(editCommandField(entry.command, entry.field, entry.raw).ok, entry.name).toBe(false);
    }
    for (const op of [
      "stopBgm", "pauseBgm", "resumeBgm", "saveBgm", "replayBgm",
      "openMenu", "openSave", "autosave", "gameOver", "returnTitle",
    ] as const) {
      expect(commandFields(defaultCommand(op))).toEqual([]);
      expect(editCommandField(defaultCommand(op), "unknown", "x").ok, op).toBe(false);
    }
  });

  test("preserves null versus omitted semantics for optional command fields", () => {
    let appearance: Command = { op: "appearance", target: "player", sprite: "hero", opacity: 128, visible: true };
    appearance = edit(appearance, "sprite", "null");
    expect(appearance).toMatchObject({ sprite: null, opacity: 128, visible: true });
    appearance = edit(appearance, "sprite", "(unset)");
    expect(appearance).not.toHaveProperty("sprite");
    appearance = edit(appearance, "opacity", "null");
    expect(appearance).toHaveProperty("opacity", null);
    appearance = edit(appearance, "opacity", "");
    expect(appearance).not.toHaveProperty("opacity");
    appearance = edit(appearance, "visible", "null");
    expect(appearance).toHaveProperty("visible", null);
    appearance = edit(appearance, "sprite", "hero");
    appearance = edit(appearance, "visible", "(unset)");
    expect(appearance).not.toHaveProperty("visible");

    let layer: Command = { op: "layer", layer: "weather", visible: true, variant: "rain" };
    layer = edit(layer, "visible", "null");
    expect(layer).toHaveProperty("visible", null);
    layer = edit(layer, "visible", "(unset)");
    expect(layer).not.toHaveProperty("visible");
    layer = edit(layer, "variant", "null");
    expect(layer).toHaveProperty("variant", null);
    layer = edit(layer, "visible", "true");
    layer = edit(layer, "variant", "(unset)");
    expect(layer).not.toHaveProperty("variant");

    let tile: Command = { op: "tileProperty", x: 0, y: 0, passage: "block", enter: ["left"] };
    tile = edit(tile, "passage", "null");
    expect(tile).toHaveProperty("passage", null);
    tile = edit(tile, "passage", "(unset)");
    expect(tile).not.toHaveProperty("passage");
    tile = edit(tile, "enter", "[]");
    expect(tile).toHaveProperty("enter", []);
    tile = edit(tile, "enter", "null");
    expect(tile).toHaveProperty("enter", null);

    let fade: Command = edit(defaultCommand("screenFade"), "color", "1,2,3,4");
    fade = edit(fade, "color", "(unset)");
    expect(fade).not.toHaveProperty("color");
    let audio: Command = edit(defaultCommand("playBgm"), "volume", "70");
    audio = edit(audio, "volume", "(unset)");
    expect(audio).not.toHaveProperty("volume");
    let backdrop: Command = edit(defaultCommand("screenBackdrop"), "variant", "null");
    expect(backdrop).toHaveProperty("variant", null);
    backdrop = edit(backdrop, "whenModalOpen", "ignore");
    expect(backdrop).toHaveProperty("whenModalOpen", "ignore");
    expect(commandFields(backdrop).find((entry) => entry.key === "whenModalOpen")).toMatchObject({
      value: "ignore", kind: "enum", options: ["(unset)", "ignore"],
    });
    backdrop = edit(backdrop, "whenModalOpen", "(unset)");
    expect(backdrop).not.toHaveProperty("whenModalOpen");
    backdrop = edit(backdrop, "variant", "(unset)");
    expect(backdrop).not.toHaveProperty("variant");
    let animation: Command = edit(defaultCommand("mapAnim"), "loop", "true");
    animation = edit(animation, "loop", "(unset)");
    expect(animation).not.toHaveProperty("loop");
    let choice: Command = edit(defaultCommand("extChoice"), "write", '{"index":"choice"}');
    choice = edit(choice, "write", "(unset)");
    expect(choice).not.toHaveProperty("write");

    expect(validateProject(projectWith([appearance, layer, tile, fade, audio, backdrop, animation, choice]))).toEqual([]);
  });

  test("text layout fields show their defaults and stay sparse", () => {
    const plain: Command = { op: "text", lines: ["Hello"], cps: 40 };
    const fields = commandFields(plain);
    expect(fields.map((entry) => [entry.key, entry.label, entry.value, entry.kind])).toEqual([
      ["lines", "LINES", "Hello", "text"],
      ["cps", "CPS", 40, "integer"],
      ["position", "POSITION", "bottom", "enum"],
      ["align", "ALIGN", "left", "enum"],
      ["valign", "V-ALIGN", "top", "enum"],
      ["background", "BACKGROUND", "window", "enum"],
    ]);
    expect(Object.fromEntries(fields.slice(2).map((entry) => [entry.key, entry.options]))).toEqual({
      position: ["top", "center", "bottom", "topLeft", "topRight", "bottomLeft", "bottomRight", "left", "right"],
      align: ["left", "center", "right"],
      valign: ["top", "center", "bottom"],
      background: ["window", "dim", "transparent"],
    });
    // Each layout field names itself in Chinese and English in its hint.
    expect(fields.slice(2).map((entry) => entry.hint?.split(" · ")[0])).toEqual(["窗口位置", "水平对齐", "垂直对齐", "窗口背景"]);
    for (const entry of fields.slice(2)) expect(entry.hint).toContain(`default ${entry.value}`);
    // The handheld editor draws these hints under the fields (Studio shows
    // every hint); no other text field asks for it.
    expect(fields.map((entry) => entry.inlineHint === true)).toEqual([false, false, true, true, true, true]);

    // Re-choosing every shown default leaves a default text byte-identical.
    let same: Command = plain;
    for (const entry of fields.slice(2)) same = edit(same, entry.key, String(entry.value));
    expect(JSON.stringify(same)).toBe(JSON.stringify(plain));

    let laid = edit(plain, "position", "bottomRight");
    laid = edit(laid, "align", "center");
    laid = edit(laid, "valign", "bottom");
    laid = edit(laid, "background", "transparent");
    expect(laid).toEqual({ op: "text", lines: ["Hello"], cps: 40, position: "bottomRight", align: "center", valign: "bottom", background: "transparent" });
    expect(commandFields(laid).slice(2).map((entry) => entry.value)).toEqual(["bottomRight", "center", "bottom", "transparent"]);
    // Changing a set value keeps its place; choosing the default removes it.
    expect(Object.keys(edit(laid, "position", "top"))).toEqual(Object.keys(laid));
    let cleared = laid;
    for (const [key, value] of [["position", "bottom"], ["align", "left"], ["valign", "top"], ["background", "window"]] as const) {
      cleared = edit(cleared, key, value);
      expect(cleared, key).not.toHaveProperty(key);
    }
    expect(JSON.stringify(cleared)).toBe(JSON.stringify(plain));
    expect(validateProject(projectWith([laid, edit(plain, "background", "dim")]))).toEqual([]);

    for (const [key, raw] of [["position", "middle"], ["position", "Bottom"], ["align", "justify"], ["valign", ""], ["background", "none"]] as const) {
      const result = editCommandField(laid, key, raw);
      expect(result.ok, `${key}=${raw}`).toBe(false);
      if (!result.ok) expect(result.error).toContain(`text ${key} must be`);
    }
  });
});

describe("choice option icons", () => {
  const twoOptions = (): Extract<Command, { op: "choices" }> => ({
    op: "choices",
    prompt: "Who?",
    options: [
      { text: "Hero", commands: [{ op: "switch", id: "picked", value: true }] },
      { text: "Guard", icon: { sprite: "npc", dir: "left", frame: 2 }, commands: [] },
    ],
  });

  test("offers an icon sprite per option and facing/pose only when one is set", () => {
    const resources = eventEditorResources(projectWith([]));
    const fields = commandFields(twoOptions(), resources);
    expect(fields.map((entry) => entry.key)).toEqual([
      "prompt", "optionCount",
      "option:0", "option:0.icon",
      "option:1", "option:1.icon", "option:1.icon.dir", "option:1.icon.frame",
      "cancel",
    ]);
    const byKey = new Map(fields.map((entry) => [entry.key, entry]));
    expect(byKey.get("option:0.icon")).toMatchObject({ label: "ICON 1", value: "(unset)", kind: "text", options: ["hero", "npc"] });
    expect(byKey.get("option:0.icon")?.hint).toContain("hero, npc");
    expect(byKey.get("option:1.icon")).toMatchObject({ value: "npc", options: ["hero", "npc"] });
    expect(byKey.get("option:1.icon.dir")).toMatchObject({ value: "left", kind: "enum", options: ["down", "left", "right", "up"] });
    expect(byKey.get("option:1.icon.frame")).toMatchObject({ value: "2", kind: "enum", options: ["0", "1", "2"] });
    // Enum cycling through the inspector reaches every legal pose.
    expect(nextFieldValue(byKey.get("option:1.icon.frame")!)).toBe("0");
  });

  test("sets, adjusts and clears an icon canonically without touching the branch", () => {
    let choices: Command = edit(twoOptions(), "option:0.icon", "hero");
    expect(choices.op === "choices" && choices.options[0]).toEqual({
      text: "Hero", icon: { sprite: "hero" }, commands: [{ op: "switch", id: "picked", value: true }],
    });
    // Schema property order survives: text, icon, commands.
    expect(choices.op === "choices" && Object.keys(choices.options[0]!)).toEqual(["text", "icon", "commands"]);

    choices = edit(choices, "option:0.icon.frame", "1");
    choices = edit(choices, "option:0.icon.dir", "up");
    expect(choices.op === "choices" && choices.options[0]!.icon).toEqual({ sprite: "hero", dir: "up", frame: 1 });
    expect(choices.op === "choices" && Object.keys(choices.options[0]!.icon!)).toEqual(["sprite", "dir", "frame"]);

    // Changing the sprite keeps the pose; defaults are omitted, not stored.
    choices = edit(choices, "option:0.icon", "npc");
    expect(choices.op === "choices" && choices.options[0]!.icon).toEqual({ sprite: "npc", dir: "up", frame: 1 });
    choices = edit(choices, "option:0.icon.dir", "down");
    choices = edit(choices, "option:0.icon.frame", "0");
    expect(choices.op === "choices" && choices.options[0]!.icon).toEqual({ sprite: "npc" });

    // Clearing removes the key entirely, for both the OMIT spelling and blank.
    const cleared = edit(choices, "option:0.icon", "(unset)");
    expect(cleared.op === "choices" && cleared.options[0]).toEqual({
      text: "Hero", commands: [{ op: "switch", id: "picked", value: true }],
    });
    const blank = edit(twoOptions(), "option:1.icon", "");
    expect(blank.op === "choices" && blank.options[1]).toEqual({ text: "Guard", commands: [] });
    expect(commandFields(blank).map((entry) => entry.key)).not.toContain("option:1.icon.dir");

    // Text edits and option-count changes keep authored icons.
    const renamed = edit(twoOptions(), "option:1", "Captain");
    expect(renamed.op === "choices" && renamed.options[1]).toEqual({ text: "Captain", icon: { sprite: "npc", dir: "left", frame: 2 }, commands: [] });
    const grown = edit(twoOptions(), "optionCount", "3");
    expect(grown.op === "choices" && grown.options[1]!.icon).toEqual({ sprite: "npc", dir: "left", frame: 2 });

    expect(validateProject(projectWith([choices, cleared, renamed, grown]))).toEqual([]);
  });

  test("rejects icon facing or pose without a sprite and out-of-range values", () => {
    for (const [key, raw] of [
      ["option:0.icon.dir", "left"],
      ["option:0.icon.frame", "1"],
      ["option:1.icon.frame", "3"],
      ["option:1.icon.frame", "-1"],
      ["option:1.icon.dir", "north"],
      ["option:2.icon", "hero"],
      ["option:1.icon.sprite", "hero"],
      ["option:1.iconx", "hero"],
    ] as const) {
      expect(editCommandField(twoOptions(), key, raw).ok, `${key}=${raw}`).toBe(false);
    }
    // An authored icon that breaks the schema is caught by the command gate.
    const broken = { ...twoOptions(), options: [twoOptions().options[0]!, { text: "Bad", icon: { sprite: "npc", frame: 5 }, commands: [] }] } as unknown as Command;
    expect(editCommandField(broken, "prompt", "Still bad").ok).toBe(false);
  });
});

describe("event inspector page and condition fields", () => {
  test("cycles page enums and toggles a schema-valid authored route", () => {
    let page: Page = { trigger: "action", commands: [] };
    const trigger = pageFieldDescriptors(page)[0]!;
    expect(nextFieldValue(trigger)).toBe("playerTouch");
    let result = editPageField(page, "trigger", nextFieldValue(trigger));
    expect(result.ok).toBe(true);
    page = result.ok ? result.value : page;
    result = editPageRouteField(page, "enabled", "true");
    page = result.ok ? result.value : page;
    result = editPageRouteField(page, "steps", "moveRight,turnTowardPlayer");
    page = result.ok ? result.value : page;
    expect(page.moveRoute).toEqual({ steps: ["moveRight", "turnTowardPlayer"], repeat: false, skippable: false });
    expect(pageRouteFieldDescriptors(page).at(-1)?.value).toBe("moveRight,turnTowardPlayer");
    expect(validateProject(projectWith([], page))).toEqual([]);
  });

  test("cycles the trigger through eventTouch last and wraps to action", () => {
    let page: Page = { trigger: "action", commands: [] };
    const seen: string[] = [page.trigger];
    for (let i = 0; i < 5; i++) {
      const result = editPageField(page, "trigger", nextFieldValue(pageFieldDescriptors(page)[0]!));
      if (!result.ok) throw new Error(result.error);
      page = result.value;
      seen.push(page.trigger);
    }
    expect(seen).toEqual(["action", "playerTouch", "autorun", "parallel", "eventTouch", "action"]);
    const touched = editPageField(page, "trigger", "eventTouch");
    expect(touched.ok && touched.value.trigger).toBe("eventTouch");
    expect(validateProject(projectWith([], { trigger: "eventTouch", blocks: true }))).toEqual([]);
  });

  test("adds, edits and deletes AND conditions while preserving unrelated payloads", () => {
    const ext: Condition = { kind: "ext", call: "quest.ready", args: { exact: [1, 2] } };
    let page: Page = { trigger: "action", condition: { switch: "legacy", all: [ext] }, commands: [] };
    page = addPageCondition(page, "gold");
    const edited = editPageConditionField(page, { kind: "all", index: 1 }, "amount", "25");
    expect(edited.ok).toBe(true);
    page = edited.ok ? edited.value : page;
    expect(page.condition?.all?.[0]).toBe(ext);
    expect(page.condition?.all?.[1]).toEqual({ kind: "gold", amount: 25 });
    const extensionEdit = editPageConditionField(page, { kind: "all", index: 0 }, "args", '{"chapter":3}');
    expect(extensionEdit.ok).toBe(true);
    if (extensionEdit.ok) {
      expect(extensionEdit.value.condition?.all?.[0]).toEqual({ kind: "ext", call: "quest.ready", args: { chapter: 3 } });
    }
    page = deletePageCondition(page, { kind: "flat", key: "switch" });
    expect(page.condition).toEqual({ all: [ext, { kind: "gold", amount: 25 }] });
    page = deletePageCondition(page, { kind: "all", index: 1 });
    expect(page.condition?.all).toEqual([ext]);
  });

  test("describes and edits all requested newer condition kinds", () => {
    const descriptors = [
      ["bgmPlaying", ["id", "negate"]],
      ["appearance", ["target", "sprite"]],
      ["tileProperty", ["x", "y", "passage", "enter", "exit"]],
      ["worldIdle", ["negate"]],
      ["timer", ["op", "seconds"]],
      ["ext", ["call", "args"]],
      ["region", ["x", "y", "id"]],
    ] as const;
    for (const [kind, keys] of descriptors) {
      const fields = conditionFields(defaultCondition(kind));
      expect(fields.map((entry) => entry.key), kind).toEqual([...keys]);
      expect(fields.every((entry) => entry.readOnly !== true), kind).toBe(true);
    }

    let page: Page = {
      trigger: "action",
      condition: { all: descriptors.map(([kind]) => defaultCondition(kind)) },
      commands: [],
    };
    const edits = [
      [0, "id", "field"],
      [1, "target", "event:event"],
      [2, "enter", "left,up"],
      [3, "negate", "true"],
      [4, "op", "<="],
      [5, "args", '{"chapter":2}'],
      [6, "id", "42"],
    ] as const;
    for (const [index, fieldName, raw] of edits) {
      const result = editPageConditionField(page, { kind: "all", index }, fieldName, raw);
      expect(result.ok, `${descriptors[index]![0]}.${fieldName}`).toBe(true);
      if (result.ok) page = result.value;
    }
    expect(page.condition?.all).toEqual([
      { kind: "bgmPlaying", id: "field", negate: false },
      { kind: "appearance", target: { event: "event" }, sprite: null },
      { kind: "tileProperty", x: 0, y: 0, passage: null, enter: ["left", "up"] },
      { kind: "worldIdle", negate: true },
      { kind: "timer", op: "<=", seconds: 0 },
      { kind: "ext", call: "game.condition", args: { chapter: 2 } },
      { kind: "region", x: 0, y: 0, id: 42 },
    ]);
    expect(validateProject(projectWith([], page))).toEqual([]);

    const conditional: Command = { op: "if", if: { kind: "bgmPlaying", id: "field" }, then: [] };
    expect(commandFields(conditional).map((entry) => [entry.key, entry.readOnly ?? false])).toEqual([
      ["if.kind", false], ["if.id", false], ["if.negate", false], ["else", false],
    ]);
    expect(editCommandField(conditional, "if.id", "rain"))
      .toMatchObject({ ok: true, value: { if: { id: "rain" } } });
  });

  test("region condition id accepts the full schema range 0..255", () => {
    // Region 0 is schema-valid (the regions plane only lists nonzero ids, so
    // 0 matches every unmarked cell) and the command factory defaults to it;
    // the editor must round-trip both boundaries instead of clamping 0 to 1.
    const edit = (raw: string) => {
      const page: Page = { trigger: "action", condition: { all: [defaultCondition("region")] }, commands: [] };
      return editPageConditionField(page, { kind: "all", index: 0 }, "id", raw);
    };
    const edited = (raw: string): Page => {
      const result = edit(raw);
      if (!result.ok) throw new Error(`expected ok for ${raw}: ${result.error}`);
      return result.value;
    };
    expect(edited("0").condition?.all).toEqual([{ kind: "region", x: 0, y: 0, id: 0 }]);
    expect(edited("255").condition?.all).toEqual([{ kind: "region", x: 0, y: 0, id: 255 }]);
    expect(edit("256").ok).toBe(false);
    expect(edit("-1").ok).toBe(false);
  });

  test("rejects invalid newer-condition values and schema-breaking omission", () => {
    const cases: Array<{ name: string; condition: Condition; field: string; raw: string }> = [
      { name: "BGM boolean", condition: defaultCondition("bgmPlaying"), field: "negate", raw: "maybe" },
      { name: "appearance target", condition: defaultCondition("appearance"), field: "target", raw: "bad id" },
      { name: "appearance sprite", condition: defaultCondition("appearance"), field: "sprite", raw: "" },
      { name: "tile coordinate", condition: defaultCondition("tileProperty"), field: "x", raw: "-1" },
      { name: "tile duplicate directions", condition: defaultCondition("tileProperty"), field: "exit", raw: "up,up" },
      { name: "tile required comparison", condition: defaultCondition("tileProperty"), field: "passage", raw: "(unset)" },
      { name: "world boolean", condition: defaultCondition("worldIdle"), field: "negate", raw: "maybe" },
      { name: "timer operator", condition: defaultCondition("timer"), field: "op", raw: "==" },
      { name: "timer seconds", condition: defaultCondition("timer"), field: "seconds", raw: "-1" },
      { name: "extension call", condition: defaultCondition("ext"), field: "call", raw: "unnamespaced" },
      { name: "extension JSON", condition: defaultCondition("ext"), field: "args", raw: "{" },
    ];
    for (const entry of cases) {
      const page: Page = { trigger: "action", condition: { all: [entry.condition] }, commands: [] };
      expect(editPageConditionField(page, { kind: "all", index: 0 }, entry.field, entry.raw).ok, entry.name)
        .toBe(false);
    }
  });

  test("preserves condition null, empty-list, and omitted meanings", () => {
    let bgmPage: Page = { trigger: "action", condition: { all: [{ kind: "bgmPlaying", id: "field" }] }, commands: [] };
    const anyBgm = editPageConditionField(bgmPage, { kind: "all", index: 0 }, "id", "(any)");
    expect(anyBgm.ok).toBe(true);
    if (anyBgm.ok) bgmPage = anyBgm.value;
    expect(bgmPage.condition?.all?.[0]).not.toHaveProperty("id");

    let tilePage: Page = {
      trigger: "action",
      condition: { all: [{ kind: "tileProperty", x: 0, y: 0, passage: "block", enter: ["left"] }] },
      commands: [],
    };
    let result = editPageConditionField(tilePage, { kind: "all", index: 0 }, "passage", "null");
    expect(result.ok).toBe(true);
    if (result.ok) tilePage = result.value;
    expect(tilePage.condition?.all?.[0]).toHaveProperty("passage", null);
    result = editPageConditionField(tilePage, { kind: "all", index: 0 }, "passage", "(unset)");
    expect(result.ok).toBe(true);
    if (result.ok) tilePage = result.value;
    expect(tilePage.condition?.all?.[0]).not.toHaveProperty("passage");
    result = editPageConditionField(tilePage, { kind: "all", index: 0 }, "enter", "[]");
    expect(result.ok).toBe(true);
    if (result.ok) tilePage = result.value;
    expect(tilePage.condition?.all?.[0]).toHaveProperty("enter", []);
    result = editPageConditionField(tilePage, { kind: "all", index: 0 }, "enter", "null");
    expect(result.ok).toBe(true);
    if (result.ok) tilePage = result.value;
    expect(tilePage.condition?.all?.[0]).toHaveProperty("enter", null);

    const appearancePage: Page = { trigger: "action", condition: { all: [{ kind: "appearance", target: "player", sprite: "hero" }] }, commands: [] };
    const reset = editPageConditionField(appearancePage, { kind: "all", index: 0 }, "sprite", "null");
    expect(reset).toMatchObject({ ok: true, value: { condition: { all: [{ sprite: null }] } } });
    expect(validateProject(projectWith([], bgmPage))).toEqual([]);
    expect(validateProject(projectWith([], tilePage))).toEqual([]);
    expect(reset.ok ? validateProject(projectWith([], reset.value)) : ["edit failed"]).toEqual([]);
  });

  test("all condition defaults are field-owned and schema-valid in one page", () => {
    const all = CONDITION_KINDS.map((kind) => defaultCondition(kind));
    expect(all.flatMap((condition) => conditionFields(condition)).every((entry) => entry.readOnly !== true)).toBe(true);
    expect(validateProject(projectWith([], { condition: { all } }))).toEqual([]);
  });
});

describe("event editor resource catalogs", () => {
  test("collects deterministic project resources and attaches field options and hints", () => {
    const commands: Command[] = [
      { op: "layer", layer: "weather", variant: "rain" },
      { op: "screenTint", layer: "overlay", color: { r: 0, g: 0, b: 0, a: 64 }, duration: 0 },
      { op: "screenBackdrop", layer: "cutscene", variant: "night" },
      { op: "showPicture", id: 1, layer: "pictures", variant: "portrait", x: 0, y: 0 },
      { op: "mapAnim", id: "spark-instance", anim: "spark", x: 0, y: 0 },
      { op: "ext", call: "quest.run", args: null },
      { op: "extChoice", call: "party.pick", args: null, prompt: "Choose" },
      { op: "if", if: { kind: "ext", call: "quest.ready", args: null }, then: [] },
      { op: "shop", id: "shop", goods: [{ item: "potion", condition: { all: [{ kind: "ext", call: "shop.available", args: null }] } }] },
      { op: "battle", setup: null, onWin: [{ op: "ext", call: "battle.win", args: null }] },
    ];
    const project = projectWith(commands, {
      condition: { all: [{ kind: "ext", call: "page.ready", args: null }] },
    });
    project.commonEvents![0]!.commands = [{ op: "ext", call: "common.tick", args: null }];
    project.maps[0]!.events!.push({ id: "guard", x: 1, y: 1, pages: [{ trigger: "action", commands: [] }] });
    project.maps.push({
      id: "z-map", name: "Other", width: 1, height: 1, sheets: ["town"], ground: ["town.0"],
      events: [{ id: "remote", x: 0, y: 0, pages: [{ trigger: "action", commands: [] }] }],
    });
    expect(validateProject(project)).toEqual([]);

    const resources = eventEditorResources(project, project.maps[0]);
    expect(resources).toEqual({
      maps: ["map", "z-map"],
      items: ["item", "potion"],
      sprites: ["hero", "npc"],
      animations: ["animation", "spark"],
      parallaxes: [],
      audio: ["audio", "door", "field", "rain", "sound", "victory"],
      commonEvents: ["ce"],
      events: ["event", "guard"],
      layers: ["cutscene", "overlay", "pictures", "weather"],
      layerVariants: { cutscene: ["night"], pictures: ["portrait"], weather: ["rain"] },
      animationInstances: ["spark-instance"],
      extensionCalls: ["battle.win", "common.tick", "page.ready", "party.pick", "quest.ready", "quest.run", "shop.available"],
    });
    expect(eventEditorResources(project).events).toEqual(["event", "guard", "remote"]);

    const fieldCases: Array<{ command: Command; key: string; options: readonly string[] }> = [
      { command: defaultCommand("transfer"), key: "map", options: resources.maps },
      { command: defaultCommand("item"), key: "item", options: resources.items },
      { command: defaultCommand("appearance"), key: "sprite", options: resources.sprites },
      { command: { op: "layer", layer: "weather", variant: "rain" }, key: "layer", options: resources.layers },
      { command: { op: "layer", layer: "weather", variant: "rain" }, key: "variant", options: ["rain"] },
      { command: defaultCommand("screenTint"), key: "layer", options: resources.layers },
      { command: { op: "showPicture", id: 1, layer: "pictures", variant: "portrait", x: 0, y: 0 }, key: "variant", options: ["portrait"] },
      { command: defaultCommand("mapAnim"), key: "anim", options: resources.animations },
      { command: { op: "stopAnim", id: "spark-instance" }, key: "id", options: resources.animationInstances },
      { command: defaultCommand("ext"), key: "call", options: resources.extensionCalls },
      { command: defaultCommand("playBgm"), key: "id", options: resources.audio },
      { command: defaultCommand("common"), key: "id", options: resources.commonEvents },
    ];
    for (const entry of fieldCases) {
      const descriptor = commandFields(entry.command, resources).find((field) => field.key === entry.key);
      expect(descriptor, `${entry.command.op}.${entry.key}`).toBeDefined();
      expect(descriptor?.options, `${entry.command.op}.${entry.key}`).toEqual(entry.options);
      expect(descriptor?.hint?.length, `${entry.command.op}.${entry.key}`).toBeGreaterThan(0);
    }

    const conditionCases: Array<{ condition: Condition; key: string; options: readonly string[] }> = [
      { condition: defaultCondition("item"), key: "id", options: resources.items },
      { condition: defaultCondition("bgmPlaying"), key: "id", options: resources.audio },
      { condition: defaultCondition("appearance"), key: "sprite", options: resources.sprites },
      { condition: defaultCondition("ext"), key: "call", options: resources.extensionCalls },
    ];
    for (const entry of conditionCases) {
      const descriptor = conditionFields(entry.condition, "", resources).find((field) => field.key === entry.key);
      expect(descriptor, `${entry.condition.kind}.${entry.key}`).toBeDefined();
      expect(descriptor?.options, `${entry.condition.kind}.${entry.key}`).toEqual(entry.options);
      expect(descriptor?.hint?.length, `${entry.condition.kind}.${entry.key}`).toBeGreaterThan(0);
    }

    const noAnimations = commandFields(defaultCommand("mapAnim")).find((field) => field.key === "anim");
    expect(noAnimations?.options).toEqual([]);
    expect(noAnimations?.hint).toContain("No project animations");
  });

  test("edits a game scene's id and JSON args", () => {
    const scene = defaultCommand("scene");
    expect(commandFields(scene).map((field) => field.key)).toEqual(["id", "args"]);
    const renamed = edit(scene, "id", "rpgkit.nameInput");
    expect(renamed).toMatchObject({ op: "scene", id: "rpgkit.nameInput" });
    const withArgs = edit(renamed, "args", '{"maxLength":8}');
    expect(withArgs).toMatchObject({ op: "scene", id: "rpgkit.nameInput", args: { maxLength: 8 } });
    expect(edit(withArgs, "args", "")).not.toHaveProperty("args");
    expect(editCommandField(scene, "id", "  ").ok).toBe(false);
    expect(editCommandField(scene, "args", "{bad").ok).toBe(false);
  });
});
