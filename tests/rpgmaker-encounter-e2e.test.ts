// Imported random encounters exercised through the complete map-session
// lifecycle. These cases pin the saved countdown to avoid mistaking a lucky
// reseed for persistence, then cross real host-rate, save, and rewind paths.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AttractController } from "../src/engine/attract.ts";
import { createSession, startSession, stepSession, type Session, type SessionState } from "../src/engine/session.ts";
import type { ExtensionOptions } from "../src/engine/extensions.ts";
import type { JsonValue, Project } from "../src/engine/types.ts";
import { canonicalJson, createSessionSnapshot, encodeEnvelope } from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import {
  createRpgMakerBattleExtensions,
  createRpgMakerBattleRules,
  rpgMakerBattleState,
} from "../src/rpgmaker-battle/rules.ts";
import type { RpgMakerBattleDatabase } from "../src/rpgmaker-battle/types.ts";
import { loadRmProject } from "../tools/rpgmaker-import/load.ts";
import { importRmProject } from "../tools/rpgmaker-import/project.ts";

const HOLLOW = join(import.meta.dir, "fixtures/rpgmaker/hollow-mz");
const RATES = [60, 30, 20] as const;
const RIGHT = 0x0020;
const LTRIGGER = 0x0100;

const raw = loadRmProject(HOLLOW);
raw.maps.get(1)!.encounterStep = 30;
raw.maps.get(1)!.encounterList = [{ troopId: 1, weight: 1, regionSet: [] }];
const imported = await importRmProject(raw);

function encounterProject(): Project {
  const project = structuredClone(imported.project);
  const map = project.maps.find((entry) => entry.id === "map001")!;
  const encounterEvent = map.events!.find((event) => event.id === "rmi-random-encounter")!;
  const floor = map.ground[0]!;
  Object.assign(map, {
    width: 16,
    height: 3,
    ground: Array(16 * 3).fill(floor),
    upper: [],
    regions: [],
    events: [encounterEvent],
    passage: [],
  });
  delete map.vehiclePassage;
  project.maps = [map];
  delete project.vehicles;
  delete project.followers;
  project.start = { map: "map001", x: 1, y: 1, dir: "right" };
  return project;
}

function initialEncounter(remaining: number): JsonValue {
  return {
    rpgmakerBattle: {
      version: 1,
      actors: {},
      battleCount: 0,
      winCount: 0,
      escapeCount: 0,
      encounter: { map: "map001", remaining },
    },
  };
}

function options(
  db: RpgMakerBattleDatabase,
  initial: ExtensionOptions["initial"],
): Parameters<typeof createSession>[2] {
  return {
    extensions: { ...createRpgMakerBattleExtensions(db), initial },
    battle: createRpgMakerBattleRules(db),
  };
}

function remaining(state: SessionState): number {
  return (state.ext as Record<string, any>).rpgmakerBattle.encounter.remaining;
}

function walkOneTile(session: Session, initial: SessionState): SessionState {
  const before = initial.sw.steps ?? 0;
  let state = initial;
  for (let frame = 0; frame < 2 * session.hz && (state.sw.steps ?? 0) === before; frame++) {
    // A direction pulse starts one move; motion then finishes without a held
    // repeat. This leaves the same tile boundary visible at every host rate.
    state = stepSession(session, state, { buttons: frame === 0 ? RIGHT : 0 });
  }
  expect(state.sw.steps).toBe(before + 1);
  state = stepSession(session, state, { buttons: 0 });
  expect(state.move.moving).toBe(false);
  expect(state.move.phase).toBe(0);
  return state;
}

function walkControllerOneTile(controller: AttractController, hz: number): number[] {
  const before = controller.state.sw.steps ?? 0;
  const inputs: number[] = [];
  for (let frame = 0; frame < 2 * hz && (controller.state.sw.steps ?? 0) === before; frame++) {
    const input = frame === 0 ? RIGHT : 0;
    controller.step(input);
    inputs.push(input);
  }
  expect(controller.state.sw.steps).toBe(before + 1);
  controller.step(0);
  inputs.push(0);
  expect(controller.state.move.moving).toBe(false);
  expect(controller.state.move.phase).toBe(0);
  return inputs;
}

function enterRandomEncounter(session: Session, initial: SessionState): SessionState {
  let state = walkOneTile(session, initial);
  for (let frame = 0; frame < session.hz && state.scene === null; frame++) {
    state = stepSession(session, state, { buttons: 0 });
  }
  expect(state.scene?.kind).toBe("battle");
  expect(rpgMakerBattleState(state.scene!.state).troopId).toBe(1);
  return state;
}

describe("imported RPG Maker random encounters end to end", () => {
  for (const hz of RATES) {
    test(`the saved countdown advances once per tile across save/load at ${hz} Hz`, () => {
      const project = encounterProject();
      const session = createSession(project, hz, options(imported.battle, initialEncounter(3)));
      const first = walkOneTile(session, startSession(project, session));

      expect(first.scene).toBeNull();
      expect(first.sw.variables["rmi-encounter-due"]).toBe(0);
      expect(remaining(first)).toBe(2);

      const restored = restoreSessionEnvelope(
        session,
        encodeEnvelope(createSessionSnapshot(session, first, 0)),
      );
      expect(remaining(restored)).toBe(2);

      const baseline = walkOneTile(session, first);
      const replayed = walkOneTile(session, restored);
      expect(remaining(replayed)).toBe(1);
      expect(canonicalJson(createSessionSnapshot(session, replayed, 0)))
        .toBe(canonicalJson(createSessionSnapshot(session, baseline, 0)));

      const baselineEncounter = enterRandomEncounter(session, baseline);
      const replayedEncounter = enterRandomEncounter(session, replayed);
      expect(canonicalJson(createSessionSnapshot(session, replayedEncounter, 0)))
        .toBe(canonicalJson(createSessionSnapshot(session, baselineEncounter, 0)));
    });

    test(`rewind restores and deterministically refolds the countdown at ${hz} Hz`, () => {
      const project = encounterProject();
      const controller = new AttractController(project, [], {
        hz,
        idleFrames: 60_000,
        rewindSeconds: 2,
        attractEnabled: false,
        ...options(imported.battle, initialEncounter(3)),
      });

      walkControllerOneTile(controller, hz);
      const targetLength = controller.length;
      const target = structuredClone(controller.state);
      expect(remaining(target)).toBe(2);

      const suffix = walkControllerOneTile(controller, hz);
      while (suffix.length < 2 * hz) {
        controller.step(0);
        suffix.push(0);
      }
      expect(suffix).toHaveLength(2 * hz);
      expect(remaining(controller.state)).toBe(1);
      const forward = structuredClone(controller.state);

      controller.step(LTRIGGER);
      expect(controller.status().rewound).toBe(true);
      expect(controller.length).toBe(targetLength);
      expect(controller.state).toEqual(target);

      for (const input of suffix) controller.step(input);
      expect(controller.state).toEqual(forward);
    });
  }
});
