// End-to-end evidence for the RPG Maker message/Steps/region bridge. The
// projects originate in the real MV/MZ importer fixtures; the tests then
// isolate one imported message and one imported region crossing so cadence,
// save/load and rewind failures are attributable to this capability.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AttractController } from "../src/engine/attract.ts";
import type { TextModal } from "../src/engine/interpreter.ts";
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

const ROOT = join(import.meta.dir, "..");
const HOLLOW = join(ROOT, "tests/fixtures/rpgmaker/hollow-mz");
const STAGE = join(ROOT, "tests/fixtures/rpgmaker/stage-mv");
const RIGHT = 0x0020;
const LEFT = 0x0080;
const L_TRIGGER = 0x0100;
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
