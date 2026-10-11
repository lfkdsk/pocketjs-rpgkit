// End-to-end evidence for the RPG Maker message/Steps/region bridge. The
// projects originate in the real MV/MZ importer fixtures; the tests then
// isolate one imported message and one imported region crossing so cadence,
// save/load and rewind failures are attributable to this capability.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AttractController } from "../src/engine/attract.ts";
import type { ScrollTextModal, TextModal } from "../src/engine/interpreter.ts";
import { createAutosaveSessionSnapshot, createSessionSnapshot } from "../src/engine/save.ts";
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
import type { RmCommand } from "../tools/rpgmaker-import/rm-types.ts";

const ROOT = join(import.meta.dir, "..");
const HOLLOW = join(ROOT, "tests/fixtures/rpgmaker/hollow-mz");
const STAGE = join(ROOT, "tests/fixtures/rpgmaker/stage-mv");
const RIGHT = 0x0020;
const LEFT = 0x0080;
const L_TRIGGER = 0x0100;
const SCROLL_FAST = 0x2000;
const RATES = [60, 30, 20] as const;

function commandsIn(project: Project): Command[] {
  const out: Command[] = [];
  const visit = (commands: readonly Command[]): void => {
    for (const command of commands) {
      out.push(command);
      if (command.op === "if") {
        visit(command.then);
        if (command.else) visit(command.else);
      } else if (command.op === "choices") {
        for (const option of command.options) visit(option.commands);
        if (command.cancel) visit(command.cancel.commands);
      } else if (command.op === "loop" || command.op === "common") {
        if (command.op === "loop") visit(command.commands);
      }
    }
  };
  for (const map of project.maps) {
    for (const event of map.events ?? []) for (const page of event.pages) visit(page.commands);
  }
  for (const common of project.commonEvents ?? []) visit(common.commands);
  return out;
}

async function importedColourProject(): Promise<Project> {
  const imported = await importRmProject(loadRmProject(STAGE));
  const project = structuredClone(imported.project);
  const command = commandsIn(project).find((candidate) =>
    candidate.op === "text" && candidate.lines.some((line) => line.includes(String.raw`\C[6]Lantern Stage\C[0]`))
  );
  if (!command || command.op !== "text") throw new Error("stage fixture lost its coloured opening message");
  const map = project.maps[0]!;
  map.events = [{
    id: "imported-colour-message",
    x: project.start.x,
    y: project.start.y,
    pages: [{ trigger: "autorun", commands: [structuredClone(command)] }],
  }];
  project.maps = [map];
  project.commonEvents = [];
  return project;
}

async function importedStepsRegionProject(): Promise<Project> {
  const rm = loadRmProject(HOLLOW);
  const page = rm.maps.get(1)!.events.find((event) => event !== null)!.pages[0]!;
  // MV Control Variables -> Game Data -> Other -> Steps, followed by the
  // ordinary narrow script comparison that the importer lowers natively.
  page.list = [
    { code: 122, indent: 0, parameters: [9, 9, 0, 3, 7, 3, 0] },
    { code: 111, indent: 0, parameters: [12, "$gameParty.steps() >= 1"] },
    { code: 121, indent: 1, parameters: [5, 5, 0] },
    { code: 0, indent: 1, parameters: [] },
    { code: 412, indent: 0, parameters: [] },
    { code: 0, indent: 0, parameters: [] },
  ];
  const imported = await importRmProject(rm);
  const project = structuredClone(imported.project);
  const map = project.maps[0]!;
  const importedCommands = structuredClone(map.events![0]!.pages[0]!.commands);
  const regionOne = map.regions?.find((entry) => entry[1] === 1)?.[0];
  if (regionOne === undefined) throw new Error("hollow fixture lost its imported region plane");
  const x = regionOne % map.width;
  const y = Math.floor(regionOne / map.width);
  const events: GameEvent[] = [
    {
      id: "imported-region-enter",
      x: 0,
      y: 0,
      pages: [{
        trigger: "regionEnter",
        region: 1,
        condition: { all: [{ kind: "steps", op: ">=", value: 1 }] },
        commands: importedCommands,
      }],
    },
    {
      id: "imported-region-leave",
      x: 0,
      y: 0,
      pages: [{
        trigger: "regionLeave",
        region: 1,
        commands: [{ op: "switch", id: "left-imported-region", value: true }],
      }],
    },
  ];
  project.sheets.push({ id: "rpgm1-floor", cols: 1, rows: 1, defaultPassage: "pass" });
  map.sheets = ["rpgm1-floor"];
  map.ground = Array(map.width * map.height).fill("rpgm1-floor.0");
  map.upper = [];
  map.events = events;
  project.maps = [map];
  project.commonEvents = [];
  project.start = { map: map.id, x: x - 1, y, dir: "right" };
  if (project.system?.stepCounter !== true) throw new Error("Steps import did not opt in the counter");
  return project;
}

function isolateAutorun(project: Project, id: string, commands: Command[]): Project {
  const map = project.maps[0]!;
  map.events = [{
    id,
    x: project.start.x,
    y: project.start.y,
    pages: [{ trigger: "autorun", commands }],
  }];
  project.maps = [map];
  project.commonEvents = [];
  return project;
}

async function importedScrollProject(): Promise<Project> {
  const rm = loadRmProject(STAGE);
  const event = rm.maps.get(1)!.events.find((candidate) => candidate !== null);
  if (!event) throw new Error("stage fixture lost its opening event");
  const rows = Array.from({ length: 24 }, (_, index) =>
    index === 4 ? "\\C[6]Imported 中日 row\\C[0]" : `Imported scrolling row ${index + 1}`);
  event.pages[0]!.list = [
    { code: 105, indent: 0, parameters: [2, false] },
    ...rows.map((row): RmCommand => ({ code: 405, indent: 0, parameters: [row] })),
    { code: 0, indent: 0, parameters: [] },
  ];
  const imported = await importRmProject(rm);
  const command = commandsIn(imported.project).find((candidate) => candidate.op === "scrollText");
  if (!command || command.op !== "scrollText") throw new Error("fixture scrolling text was not imported");
  return isolateAutorun(structuredClone(imported.project), "imported-scroll", [structuredClone(command)]);
}

async function importedAudioProject(): Promise<Project> {
  const rm = loadRmProject(STAGE);
  for (const event of rm.maps.get(1)!.events) {
    for (const page of event?.pages ?? []) {
      for (const command of page.list) {
        const audio = command.parameters?.[0];
        if (command.code === 241 && audio && typeof audio === "object") {
          command.parameters![0] = { ...(audio as object), pan: -60 };
        } else if (command.code === 249 && audio && typeof audio === "object") {
          command.parameters![0] = { ...(audio as object), pan: 75 };
        }
      }
    }
  }
  const imported = await importRmProject(rm);
  const commands = commandsIn(imported.project);
  const bgm = commands.find((command) => command.op === "playBgm" && command.id === "bgm-stage-overture");
  const me = commands.find((command) => command.op === "playMe" && command.id === "me-stage-fanfare");
  if (!bgm || bgm.op !== "playBgm" || !me || me.op !== "playMe") {
    throw new Error("stage fixture lost its imported BGM/ME pair");
  }
  if (me.duration !== 48 / 60) throw new Error(`expected media-derived 48-tick ME, got ${me.duration}`);
  return isolateAutorun(structuredClone(imported.project), "imported-audio", [
    structuredClone(bgm),
    structuredClone(me),
    { op: "erase" },
  ]);
}

function actorBranch(subtype: number, value: string | number, switchId: number): RmCommand[] {
  return [
    { code: 111, indent: 0, parameters: [4, 1, subtype, value] },
    { code: 121, indent: 1, parameters: [switchId, switchId, 0] },
    { code: 0, indent: 1, parameters: [] },
    { code: 412, indent: 0, parameters: [] },
  ];
}

async function importedActorProject(): Promise<Project> {
  const rm = loadRmProject(HOLLOW);
  const event = rm.maps.get(1)!.events.find((candidate) => candidate !== null);
  if (!event) throw new Error("hollow fixture lost its opening event");
  event.pages[0]!.list = [
    ...actorBranch(1, "Wren", 14),
    ...actorBranch(2, 1, 15),
    ...actorBranch(3, 1, 16),
    ...actorBranch(4, 1, 17),
    ...actorBranch(5, 1, 18),
    { code: 0, indent: 0, parameters: [] },
  ];
  const imported = await importRmProject(rm);
  const commands = structuredClone(imported.project.maps[0]!.events![0]!.pages[0]!.commands);
  commands.push({ op: "erase" });
  return isolateAutorun(structuredClone(imported.project), "imported-actors", commands);
}

function drive(session: Session, state: SessionState, masks: readonly number[]): SessionState {
  let next = state;
  for (const buttons of masks) next = stepSession(session, next, { buttons });
  return next;
}

function modalEvidence(state: SessionState) {
  const modal = state.interp.modal as TextModal;
  return {
    lines: modal.lines,
    revealed: modal.revealed,
    complete: modal.complete,
    colours: modal.colours,
  };
}

function regionEvidence(state: SessionState) {
  return {
    cell: [state.move.tx, state.move.ty],
    steps: state.sw.steps,
    observed: state.sw.variables.v009,
    threshold: state.sw.switches.s005,
    left: state.sw.switches["left-imported-region"],
    pending: state.interp.pendingRegionTriggers,
  };
}

function scrollEvidence(state: SessionState) {
  const modal = state.interp.modal as ScrollTextModal;
  return {
    kind: modal.kind,
    lines: modal.lines,
    colours: modal.colours,
    speed: modal.speed,
    noFastForward: modal.noFastForward,
    offset2: modal.offset2,
    contentHeight: modal.contentHeight,
    viewportHeight: modal.viewportHeight,
  };
}

function audioEvidence(state: SessionState) {
  return structuredClone(state.interp.audio);
}

function actorEvidence(state: SessionState) {
  return ["s014", "s015", "s016", "s017", "s018"].map((id) => state.sw.switches[id] ?? false);
}

describe("RPG Maker imported message E2E", () => {
  test("colour text is cadence-stable and survives save/load plus rewind/replay", async () => {
    const project = await importedColourProject();
    const results: ReturnType<typeof modalEvidence>[] = [];
    for (const hz of RATES) {
      const masks = Array(hz).fill(0);
      const session = createSession(project, hz);
      const terminal = drive(session, startSession(project, session), masks);
      expect((terminal.interp.modal as TextModal).lines.join("\n")).toContain("Lantern Stage!");
      expect((terminal.interp.modal as TextModal).colours?.some((span) => span.colour !== "#FFFFFF")).toBe(true);

      // Manual saves deliberately refuse an open modal; reducer autosaves
      // carry the live typewriter and its colour spans.
      const snapshot = createAutosaveSessionSnapshot(session, terminal, 0);
      expect(snapshot).not.toBeNull();
      const loaded = loadSession(session, snapshot!);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) continue;
      expect(loaded.state).toEqual(terminal);
      expect(loaded.held).toBe(0);

      const controller = new AttractController(project, [], {
        hz,
        attractEnabled: false,
        idleFrames: hz * 10,
        rewindSeconds: 1,
      });
      for (const mask of masks) controller.step(mask);
      const beforeRewind = structuredClone(controller.state);
      controller.step(L_TRIGGER);
      expect(controller.length).toBe(0);
      expect(controller.state.interp.modal).toBeNull();
      for (const mask of masks) controller.step(mask);
      expect(controller.state).toEqual(beforeRewind);
      results.push(modalEvidence(terminal));
    }
    expect(results).toEqual([results[0], results[0], results[0]]);
  });
});

describe("RPG Maker imported scrolling text E2E", () => {
  test("105/405 stays cadence-stable through autosave and rewind", async () => {
    const project = await importedScrollProject();
    const layoutScrollText = () => ({ contentHeight: 24 * 15, viewportHeight: 272 });
    const results: ReturnType<typeof scrollEvidence>[] = [];
    for (const hz of RATES) {
      const half = Array(hz / 2).fill(SCROLL_FAST);
      const masks = [...half, ...half];
      const session = createSession(project, hz, { layoutScrollText });
      const mid = drive(session, startSession(project, session), half);
      expect(mid.interp.modal?.kind).toBe("scrollText");
      const saved = createAutosaveSessionSnapshot(session, mid, SCROLL_FAST);
      expect(saved).not.toBeNull();
      const loaded = loadSession(session, saved!);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) continue;
      expect(loaded.state).toEqual(mid);
      const terminal = drive(session, loaded.state, half);
      expect((terminal.interp.modal as ScrollTextModal).offset2).toBe(354);

      const controller = new AttractController(project, [], {
        hz,
        attractEnabled: false,
        rewindSeconds: 1,
        layoutScrollText,
      });
      for (const mask of masks) controller.step(mask);
      const beforeRewind = structuredClone(controller.state);
      controller.step(L_TRIGGER);
      expect(controller.length).toBe(0);
      expect(controller.state.interp.modal).toBeNull();
      for (const mask of masks) controller.step(mask);
      expect(controller.state).toEqual(beforeRewind);
      results.push(scrollEvidence(terminal));
    }
    expect(results).toEqual([results[0], results[0], results[0]]);
    expect(results[0]?.lines[4]).toContain("Imported 中日 row");
    expect(results[0]?.colours?.some((span) => span.colour !== "#FFFFFF")).toBe(true);
  });
});

describe("RPG Maker imported audio E2E", () => {
  test("media-derived ME timing, pan and BGM restoration survive cadence, save and rewind", async () => {
    const project = await importedAudioProject();
    const results: ReturnType<typeof audioEvidence>[] = [];
    for (const hz of RATES) {
      const half = Array(hz / 2).fill(0);
      const session = createSession(project, hz);
      const mid = drive(session, startSession(project, session), half);
      expect(mid.interp.audio?.bgm).toMatchObject({ id: "bgm-stage-overture", pan: -60, positionTicks: 0 });
      expect(mid.interp.audio?.me).toMatchObject({
        id: "me-stage-fanfare", pan: 75, durationTicks: 48, leftTicks: 19,
      });
      const loaded = loadSession(session, createSessionSnapshot(session, mid, 0));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) continue;
      expect(loaded.state).toEqual(mid);
      const terminal = drive(session, loaded.state, Array(hz).fill(0));
      expect(terminal.interp.audio?.me).toBeUndefined();
      expect(terminal.interp.audio?.bgm).toMatchObject({ id: "bgm-stage-overture", pan: -60 });
      expect(terminal.interp.audio?.bgm?.fade).toBeUndefined();

      const controller = new AttractController(project, [], {
        hz,
        attractEnabled: false,
        rewindSeconds: 1,
      });
      for (let frame = 0; frame < hz; frame++) controller.step(0);
      const beforeRewind = structuredClone(controller.state);
      controller.step(L_TRIGGER);
      expect(controller.length).toBe(0);
      for (let frame = 0; frame < hz; frame++) controller.step(0);
      expect(controller.state).toEqual(beforeRewind);
      results.push(audioEvidence(terminal));
    }
    expect(results).toEqual([results[0], results[0], results[0]]);
  });
});

describe("RPG Maker imported actor-condition E2E", () => {
  test("initial actor facts execute identically through save/load and rewind", async () => {
    const project = await importedActorProject();
    const results: ReturnType<typeof actorEvidence>[] = [];
    for (const hz of RATES) {
      const masks = Array(hz).fill(0);
      const session = createSession(project, hz, { immutableState: true });
      const mid = drive(session, startSession(project, session), masks.slice(0, hz / 2));
      expect(actorEvidence(mid)).toEqual([true, true, true, true, true]);
      const loaded = loadSession(session, createSessionSnapshot(session, mid, 0));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) continue;
      expect(loaded.state).toEqual(mid);
      const terminal = drive(session, loaded.state, masks.slice(hz / 2));

      const controller = new AttractController(project, [], {
        hz,
        attractEnabled: false,
        rewindSeconds: 1,
        immutableState: true,
      });
      for (const mask of masks) controller.step(mask);
      const beforeRewind = structuredClone(controller.state);
      controller.step(L_TRIGGER);
      expect(controller.length).toBe(0);
      for (const mask of masks) controller.step(mask);
      expect(controller.state).toEqual(beforeRewind);
      results.push(actorEvidence(terminal));
    }
    expect(results).toEqual([[true, true, true, true, true], [true, true, true, true, true], [true, true, true, true, true]]);
  });
});

describe("RPG Maker imported Steps and region E2E", () => {
  test("the imported plane and Steps commands are cadence-stable across save/load and rewind/replay", async () => {
    const project = await importedStepsRegionProject();
    const results: ReturnType<typeof regionEvidence>[] = [];
    for (const hz of RATES) {
      const enterMasks = [RIGHT, ...Array(hz - 1).fill(0)];
      const leaveMasks = [LEFT, ...Array(hz - 1).fill(0)];
      const session = createSession(project, hz, { immutableState: true });
      const entered = drive(session, startSession(project, session), enterMasks);
      expect(entered.sw.steps).toBe(1);
      expect(entered.sw.variables.v009).toBe(1);
      expect(entered.sw.switches.s005).toBe(true);

      const loaded = loadSession(session, createSessionSnapshot(session, entered, 0));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) continue;
      const terminal = drive(session, loaded.state, leaveMasks);
      expect(terminal.sw.steps).toBe(2);
      expect(terminal.sw.switches["left-imported-region"]).toBe(true);

      const masks = [...enterMasks, ...leaveMasks];
      const controller = new AttractController(project, [], {
        hz,
        attractEnabled: false,
        idleFrames: hz * 10,
        rewindSeconds: 2,
        immutableState: true,
      });
      for (const mask of masks) controller.step(mask);
      const beforeRewind = structuredClone(controller.state);
      controller.step(L_TRIGGER);
      expect(controller.length).toBe(0);
      expect(controller.state.sw.steps ?? 0).toBe(0);
      for (const mask of masks) controller.step(mask);
      expect(controller.state).toEqual(beforeRewind);
      results.push(regionEvidence(terminal));
    }
    expect(results).toEqual([results[0], results[0], results[0]]);
  });
});
