// End-to-end coverage for the import-time RPG Maker Script subset. The
// source snippets below are self-authored fixtures injected into the existing
// synthetic MZ project, then imported and driven through the real session
// reducer at every supported host rate. No fixture source is ever evaluated.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AttractController } from "../src/engine/attract.ts";
import type { TextModal } from "../src/engine/interpreter.ts";
import { rpgMakerTextRuntime } from "../src/engine/rpgmaker-text.ts";
import { canonicalJson, createAutosaveSessionSnapshot, createSessionSnapshot } from "../src/engine/save.ts";
import { loadSession } from "../src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type { Command, GameEvent, Project } from "../src/engine/types.ts";
import { loadRmProject } from "../tools/rpgmaker-import/load.ts";
import { importRmProject } from "../tools/rpgmaker-import/project.ts";
import type { Coverage } from "../tools/rpgmaker-import/coverage.ts";
import type { RmCommand, RmEvent, RmEventPage } from "../tools/rpgmaker-import/rm-types.ts";

const HOLLOW = join(import.meta.dir, "fixtures/rpgmaker/hollow-mz");
const RATES = [60, 30, 20] as const;
const CIRCLE = 0x2000;
const L_TRIGGER = 0x0100;

const command = (code: number, indent: number, parameters: unknown[] = []): RmCommand =>
  ({ code, indent, parameters });

function conditionBranch(source: string, switchId: number): RmCommand[] {
  return [
    command(111, 0, [12, source]),
    command(121, 1, [switchId, switchId, 0]),
    command(0, 1),
    command(412, 0),
  ];
}

function scriptLines(lines: readonly string[]): RmCommand[] {
  return lines.map((line, index) => command(index === 0 ? 355 : 655, 0, [line]));
}

function resetPage(page: RmEventPage, trigger: number): RmEventPage {
  return {
    ...page,
    conditions: {
      ...page.conditions,
      actorValid: false,
      itemValid: false,
      selfSwitchValid: false,
      switch1Valid: false,
      switch2Valid: false,
      variableValid: false,
    },
    image: { tileId: 0, characterName: "", characterIndex: 0, direction: 2, pattern: 1 },
    list: [command(0, 0)],
    moveType: 0,
    priorityType: 0,
    trigger,
    through: true,
  };
}

function fixtureEvent(template: RmEvent, id: number, name: string, x: number, y: number): RmEvent {
  return { ...structuredClone(template), id, name, x, y, pages: [] };
}

async function importedScriptFixture(): Promise<{ project: Project; cov: Coverage }> {
  const rm = loadRmProject(HOLLOW);
  const map = rm.maps.get(1)!;
  const template = map.events[2];
  if (!template) throw new Error("hollow fixture lost event 2");

  const first = resetPage(structuredClone(template.pages[0]!), 3);
  first.list = [
    ...scriptLines([
      "$gameMap.requestRefresh();",
      "$gameVariables.setValue(1, 4);",
      "$gameVariables.setValue(2, $gameVariables.value(1) + 3);",
      "$gameSwitches.setValue(3, true);",
      "$gameParty.gainItem($dataItems[1], 2);",
      "$gameParty.loseItem($dataItems[1], 1);",
      "$gameParty.gainGold(40);",
      "$gameParty.loseGold(10);",
      "$gameMap.event(2).setPosition(7, 8);",
      "$gameMap.event(2).setDirection(8);",
      "AudioManager.playSe({name:'ScriptTone',volume:80,pitch:110,pan:-20});",
      "AudioManager.playBgm({name:'ScriptTheme',volume:70,pitch:100,pan:10});",
    ]),
    ...conditionBranch("$gameVariables.value(2) > 4", 4),
    ...conditionBranch("$gameSwitches.value(3)", 5),
    ...conditionBranch("$gameParty.hasItem($dataItems[1])", 6),
    ...conditionBranch("$gameParty.numItems($dataItems[1]) >= 1", 7),
    ...conditionBranch("$gamePlayer.direction() === 2", 8),
    ...conditionBranch("$gameParty.steps() >= 0", 9),
    ...scriptLines([
      "$gameMessage.add('Script subset ready');",
      "$gameSelfSwitches.setValue([1, 10, 'A'], true);",
      "$gamePlayer.locate(12, 9);",
      "$gamePlayer.reserveTransfer(2, 3, 4, 6, 2);",
    ]),
    command(0, 0),
  ];
  const stopped = resetPage(structuredClone(template.pages[0]!), 0);
  stopped.conditions.selfSwitchValid = true;
  stopped.conditions.selfSwitchCh = "A";
  const scripted = fixtureEvent(template, 10, "Safe Script", 0, 0);
  scripted.pages = [first, stopped];
  map.events[10] = scripted;

  // Recognized-but-unrepresentable player coordinates and include-equipped
  // inventory semantics remain classified, source-visible placeholders on
  // an action event that the runtime tape never triggers.
  const classifiedPage = resetPage(structuredClone(template.pages[0]!), 0);
  classifiedPage.list = [
    ...conditionBranch("$gamePlayer.x === 11", 10),
    ...conditionBranch("$gamePlayer.y !== 9", 11),
    ...conditionBranch("$gameParty.hasItem($dataArmors[1], true)", 12),
    command(0, 0),
  ];
  const classified = fixtureEvent(template, 11, "Classified Script", 0, 0);
  classified.pages = [classifiedPage];
  map.events[11] = classified;

  const imported = await importRmProject(rm);
  const project = structuredClone(imported.project);
  const map1 = project.maps.find((candidate) => candidate.id === "map001")!;
  const map2 = project.maps.find((candidate) => candidate.id === "map002")!;
  const event10 = map1.events?.find((event) => event.id === "ev010");
  const event11 = map1.events?.find((event) => event.id === "ev011");
  const event2 = map1.events?.find((event) => event.id === "ev002");
  if (!event10 || !event11 || !event2) throw new Error("script fixture events were not imported");

  // Keep the imported event commands but remove unrelated fixture autoruns,
  // common events, travel actors, and destination-map events.
  map1.events = [event10, event11, event2];
  map2.events = [];
  project.maps = [map1, map2];
  project.commonEvents = [];
  delete project.followers;
  delete project.vehicles;
  project.audio = {
    "se-scripttone": "audio:qoa.se-scripttone",
    "bgm-scripttheme": "audio:qoa.bgm-scripttheme",
  };
  project.start = { map: "map001", x: 11, y: 9, dir: "down" };
  return { project, cov: imported.cov };
}

const imported = await importedScriptFixture();

function walkCommands(commands: readonly Command[]): Command[] {
  const out: Command[] = [];
  for (const value of commands) {
    out.push(value);
    if (value.op === "if") out.push(...walkCommands(value.then), ...walkCommands(value.else ?? []));
    else if (value.op === "choices") {
      for (const option of value.options) out.push(...walkCommands(option.commands));
      if (value.cancel) out.push(...walkCommands(value.cancel.commands));
    } else if (value.op === "loop") out.push(...walkCommands(value.commands));
  }
  return out;
}

function scriptEvent(project: Project): GameEvent {
  return project.maps[0]!.events!.find((event) => event.id === "ev010")!;
}

function advanceToMessage(session: Session, initial: SessionState): { state: SessionState; heard: string[] } {
  let state = initial;
  const heard: string[] = [];
  for (let frame = 0; frame < 2 * session.hz; frame++) {
    state = stepSession(session, state, { buttons: 0 });
    for (const cue of state.interp.cues) if ("name" in cue) heard.push(cue.name);
    if (state.interp.modal?.kind === "text" && state.interp.cues.length === 0) return { state, heard };
  }
  throw new Error(`Script message did not open at ${session.hz} Hz`);
}

function closeMessage(session: Session, initial: SessionState): SessionState {
  let state = initial;
  for (let pulse = 0; pulse < 4 && state.interp.modal !== null; pulse++) {
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    state = stepSession(session, state, { buttons: 0 });
  }
  expect(state.interp.modal).toBeNull();
  for (let frame = 0; frame < session.hz; frame++) state = stepSession(session, state, { buttons: 0 });
  return state;
}

function evidence(state: SessionState) {
  return {
    map: state.mapId,
    cell: [state.move.tx, state.move.ty],
    variables: [state.sw.variables.v001, state.sw.variables.v002],
    switches: [3, 4, 5, 6, 7, 8, 9].map((id) => state.sw.switches[`s${String(id).padStart(3, "0")}`] ?? false),
    item: state.sw.items.item001,
    gold: state.sw.gold,
    self: state.sw.self["map001/ev010"],
    bgm: state.interp.audio?.bgm && {
      id: state.interp.audio.bgm.id,
      volume: state.interp.audio.bgm.volume,
      pitch: state.interp.audio.bgm.pitch,
      pan: state.interp.audio.bgm.pan,
    },
  };
}

describe("imported RPG Maker safe Script subset", () => {
  test("every allowlisted action and condition shape crosses the importer boundary", () => {
    const commands = walkCommands(scriptEvent(imported.project).pages[0]!.commands);
    const ops = new Set(commands.map((value) => value.op));
    for (const op of ["variable", "switch", "item", "gold", "place", "moveRoute", "playSe", "playBgm", "text", "selfSwitch", "transfer", "if"]) {
      expect(ops.has(op as Command["op"]), `missing imported op ${op}`).toBe(true);
    }
    expect(commands).toContainEqual({ op: "place", target: { event: "ev002" }, x: 7, y: 8 });
    expect(commands).toContainEqual({ op: "place", target: "player", x: 12, y: 9 });
    expect(commands).toContainEqual({ op: "transfer", map: "map002", x: 3, y: 4, dir: "right" });
    expect(commands).toContainEqual({ op: "text", lines: ["Script subset ready"] });

    const classified = imported.project.maps[0]!.events!.find((event) => event.id === "ev011")!;
    const classifiedCommands = walkCommands(classified.pages[0]!.commands);
    expect(classifiedCommands.filter((value) => value.op === "text")).toHaveLength(2);

    const rows = imported.cov.list("script");
    expect(rows.find((row) => row.key === "$gameMap.requestRefresh()")?.counts.Native).toBe(1);
    expect(rows.find((row) => row.key === "$gameParty.numItems(dataItem) comparison number")?.counts.Native).toBe(1);
    expect(rows.find((row) => row.key === "$gamePlayer.x comparison number")?.counts.Placeholder).toBe(1);
    expect(rows.find((row) => row.key === "$gamePlayer.y comparison number")?.counts.Placeholder).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("Script subset ready");
    expect(JSON.stringify(rows)).not.toContain("ScriptTone");
  });

  test("60/30/20 Hz, save/load, and rewind replay produce the same imported result", () => {
    const results: ReturnType<typeof evidence>[] = [];
    for (const hz of RATES) {
      const session = createSession(imported.project, hz, {
        immutableState: true,
        rpgMakerText: rpgMakerTextRuntime,
      });
      const opened = advanceToMessage(session, startSession(imported.project, session));
      expect(opened.heard).toContain("se-scripttone");
      expect((opened.state.interp.modal as TextModal).lines).toEqual(["Script subset ready"]);
      expect(opened.state.sw.variables.v001).toBe(4);
      expect(opened.state.sw.variables.v002).toBe(7);
      expect(opened.state.sw.items.item001).toBe(1);
      expect(opened.state.sw.gold).toBe(30);
      expect([3, 4, 5, 6, 7, 8, 9].map((id) => opened.state.sw.switches[`s${String(id).padStart(3, "0")}`])).toEqual(Array(7).fill(true));
      expect(opened.state.chars.chars.ev002).toMatchObject({ tx: 7, ty: 8, facing: 2 });

      const autosave = createAutosaveSessionSnapshot(session, opened.state, 0);
      expect(autosave).not.toBeNull();
      const loaded = loadSession(session, autosave!);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) continue;
      expect(loaded.state).toEqual(opened.state);
      const terminal = closeMessage(session, loaded.state);
      expect(evidence(terminal)).toEqual({
        map: "map002",
        cell: [3, 4],
        variables: [4, 7],
        switches: Array(7).fill(true),
        item: 1,
        gold: 30,
        self: "A",
        bgm: { id: "bgm-scripttheme", volume: 70, pitch: 100, pan: 10 },
      });
      const terminalSnapshot = createSessionSnapshot(session, terminal, 0);
      const terminalLoad = loadSession(session, terminalSnapshot);
      expect(terminalLoad.ok).toBe(true);
      if (terminalLoad.ok) {
        expect(evidence(terminalLoad.state)).toEqual(evidence(terminal));
        expect(canonicalJson(createSessionSnapshot(session, terminalLoad.state, 0))).toBe(canonicalJson(terminalSnapshot));
      }

      const masks = [...Array(hz).fill(0), CIRCLE, 0, CIRCLE, 0, ...Array(hz).fill(0)];
      const controller = new AttractController(imported.project, [], {
        hz,
        attractEnabled: false,
        idleFrames: hz * 10,
        rewindSeconds: 3,
        immutableState: true,
        rpgMakerText: rpgMakerTextRuntime,
      });
      for (const mask of masks) controller.step(mask);
      const beforeRewind = structuredClone(controller.state);
      expect(evidence(beforeRewind)).toEqual(evidence(terminal));
      controller.step(L_TRIGGER);
      expect(controller.length).toBe(0);
      for (const mask of masks) controller.step(mask);
      expect(controller.state).toEqual(beforeRewind);
      results.push(evidence(terminal));
    }
    expect(results).toEqual([results[0], results[0], results[0]]);
  });
});
