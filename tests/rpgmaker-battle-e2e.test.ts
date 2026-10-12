// Imported Battle Processing exercised through the complete session/interpreter
// lifecycle. These cases deliberately start beside Hollow's real Golem event:
// the 301 setup and 601/602/603 branches all come from the importer fixture.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AttractController } from "../src/engine/attract.ts";
import { createSession, startSession, stepSession, type Session, type SessionInput, type SessionState } from "../src/engine/session.ts";
import type { ExtensionOptions } from "../src/engine/extensions.ts";
import type { Project } from "../src/engine/types.ts";
import { NAME_INPUT_SCENE_ID, nameInputRules } from "../src/engine/name-input.ts";
import { canonicalJson, createSessionSnapshot, encodeEnvelope } from "../src/engine/save.ts";
import { restoreSessionEnvelope, restoreSessionSnapshot } from "../src/engine/save-restore.ts";
import {
  createRpgMakerBattleExtensions,
  createRpgMakerBattleRules,
  rpgMakerBattleState,
} from "../src/rpgmaker-battle/rules.ts";
import type { RpgMakerBattleDatabase } from "../src/rpgmaker-battle/types.ts";
import { loadRmProject } from "../tools/rpgmaker-import/load.ts";
import { importRmProject } from "../tools/rpgmaker-import/project.ts";

const HOLLOW = join(import.meta.dir, "fixtures/rpgmaker/hollow-mz");
const imported = await importRmProject(loadRmProject(HOLLOW));
const RIGHT = 0x0020;
const LTRIGGER = 0x0100;
const CIRCLE = 0x2000;

type Outcome = "win" | "escape" | "lose";

function battleProject(source: Project = imported.project): Project {
  const project = structuredClone(source);
  project.start = { map: "map003", x: 10, y: 5, dir: "up" };
  const cave = project.maps.find((map) => map.id === "map003")!;
  cave.events = cave.events?.filter((event) => event.id === "ev002");
  return project;
}

function options(
  db: RpgMakerBattleDatabase,
  initial?: ExtensionOptions["initial"],
): Parameters<typeof createSession>[2] {
  return {
    extensions: { ...createRpgMakerBattleExtensions(db), ...(initial === undefined ? {} : { initial }) },
    battle: createRpgMakerBattleRules(db),
    scenes: { [NAME_INPUT_SCENE_ID]: nameInputRules },
  };
}

function pulse(session: Session, state: SessionState, edges: Omit<SessionInput, "buttons"> = {}): SessionState {
  const pressed = stepSession(session, state, { buttons: 0, ...edges });
  return stepSession(session, pressed, { buttons: 0 });
}

function enterBattle(session: Session, initial: SessionState): SessionState {
  let state = initial;
  for (let frame = 0; frame < 500 && state.scene?.kind !== "battle"; frame++) {
    state = pulse(session, state, { confirmEdge: true });
  }
  expect(state.scene?.kind).toBe("battle");
  return state;
}

function finishBattle(session: Session, initial: SessionState, outcome: Outcome): SessionState {
  let state = initial;
  let choseParty = false;
  let choseGuard = false;
  for (let frame = 0; frame < 2_000 && state.scene !== null; frame++) {
    const battle = rpgMakerBattleState(state.scene!.state);
    if (outcome === "escape" && battle.phase === "party" && !choseParty) {
      state = pulse(session, state, { downEdge: true });
      choseParty = true;
    } else if (outcome === "lose" && battle.phase === "command" && !choseGuard) {
      state = pulse(session, state, { downEdge: true });
      choseGuard = true;
    } else {
      state = pulse(session, state, { confirmEdge: true });
    }
  }
  expect(state.scene).toBeNull();
  return state;
}

function settleEvent(session: Session, initial: SessionState): SessionState {
  let state = initial;
  for (let frame = 0; frame < 2_000; frame++) {
    if (state.interp.main === null && state.interp.modal === null && state.scene === null) return state;
    state = pulse(session, state, { confirmEdge: true });
  }
  throw new Error("imported battle branch did not settle");
}

function lowHpExtension(): ExtensionOptions["initial"] {
  return {
    rpgmakerBattle: {
      version: 1,
      actors: {
        "1": {
          actorId: 1, classId: 1, level: 1, exp: 0,
          hp: 1, mp: 60, tp: 0, skills: [1], states: [], buffs: [],
        },
      },
      battleCount: 0,
      winCount: 0,
      escapeCount: 0,
      encounter: null,
    },
  };
}

describe("imported RPG Maker Battle Processing end to end", () => {
  test("a map formation swap determines the imported battle slot order", () => {
    const db = structuredClone(imported.battle);
    db.party = [1, 2];
    const project = battleProject();
    project.system!.rpgMakerText!.party = [1, 2];
    const commands = project.maps.find((map) => map.id === "map003")!
      .events!.find((event) => event.id === "ev002")!.pages[0]!.commands;
    const battleAt = commands.findIndex((command) => command.op === "battle");
    expect(battleAt).toBeGreaterThanOrEqual(0);
    commands.splice(battleAt, 0,
      { op: "formationAccess", enabled: true },
      { op: "formationSwap", first: 0, second: 1 },
    );

    const session = createSession(project, 60, options(db));
    const entered = enterBattle(session, startSession(project, session));
    expect(entered.sw.partyOrder).toEqual([2, 1]);
    expect(rpgMakerBattleState(entered.scene!.state).actors.map((actor) => actor.databaseId))
      .toEqual([2, 1]);
  });

  test("map actor changes reach the imported battle through inventory and saved actor state", () => {
    const db = structuredClone(imported.battle);
    const project = battleProject();
    const session = createSession(project, 60, options(db));
    const entered = enterBattle(session, startSession(project, session));
    const battle = rpgMakerBattleState(entered.scene!.state);
    const actor = battle.actors[0]!;

    expect(actor.hp).toBe(415);
    expect(actor.states).toEqual([{ id: 3, turns: 3 }]);
    expect(actor.actor?.equips?.[0]).toEqual({ kind: "weapon", id: 2 });
    expect(actor.params[2]).toBe(32);
    expect(entered.sw.items.weapon001).toBe(1);
    expect(entered.sw.items.weapon002).toBeUndefined();
  });

  test("fixture troop events appear, transform, recover, animate-degrade, and force an action once", async () => {
    const raw = loadRmProject(HOLLOW);
    const command = raw.maps.get(3)!.events[2]!.pages[0]!.list.find((entry) => entry.code === 301)!;
    command.parameters = [0, 2, true, true];
    const generated = await importRmProject(raw);
    const project = battleProject(generated.project);
    const session = createSession(project, 60, options(generated.battle));
    const entered = enterBattle(session, startSession(project, session));
    const battle = rpgMakerBattleState(entered.scene!.state);

    expect(battle.enemies).toHaveLength(2);
    expect(battle.enemies[1]).toMatchObject({
      databaseId: 2,
      name: "Golem Echo",
      hidden: false,
      hp: 80,
      mp: 20,
      states: [],
      lastTargetIndex: 0,
    });
    expect(battle.enemies[1]!.tp).toBeGreaterThanOrEqual(20);
    expect(battle.message).toContain("Golem Echo uses Attack");
    expect(battle.battleAnimation).toBeNull();
  });

  test("fixture Abort Battle takes the escape branch when escape is disabled", async () => {
    const raw = loadRmProject(HOLLOW);
    const command = raw.maps.get(3)!.events[2]!.pages[0]!.list.find((entry) => entry.code === 301)!;
    command.parameters = [0, 3, false, true];
    const generated = await importRmProject(raw);
    const project = battleProject(generated.project);
    const importedBattle = project.maps.find((entry) => entry.id === "map003")!
      .events!.find((entry) => entry.id === "ev002")!.pages[0]!.commands.find((entry) => entry.op === "battle");
    expect(importedBattle).toMatchObject({ setup: { troop: 3, canEscape: false } });
    const session = createSession(project, 60, options(generated.battle));
    let state = startSession(project, session);
    for (let frame = 0; frame < 2_000 && state.sw.variables.v006 !== 1; frame++) {
      state = pulse(session, state, { confirmEdge: true });
    }
    expect(state.sw.variables.v006).toBe(1);
    expect(state.scene).toBeNull();
  });

  test("an opted-in mid-battle save restores the exact reducer worldline", () => {
    const db = structuredClone(imported.battle);
    db.enemies[0]!.params[0] = 1;
    db.enemies[0]!.exp = 200;
    db.enemies[0]!.gold = 37;
    const project = battleProject();
    const session = createSession(project, 60, options(db));
    let middle = enterBattle(session, startSession(project, session));
    middle = pulse(session, middle, { confirmEdge: true }); // intro -> party
    middle = pulse(session, middle, { confirmEdge: true }); // fight -> command
    expect(rpgMakerBattleState(middle.scene!.state).phase).toBe("command");

    const snapshot = createSessionSnapshot(session, middle, 0);
    expect(snapshot.battle?.kind).toBe("battle");
    const restored = restoreSessionEnvelope(session, encodeEnvelope(snapshot));
    expect(restored.scene).toEqual(middle.scene);

    const baseline = settleEvent(session, finishBattle(session, middle, "win"));
    const replayed = settleEvent(session, finishBattle(session, restored, "win"));
    expect(canonicalJson(createSessionSnapshot(session, replayed, 0)))
      .toBe(canonicalJson(createSessionSnapshot(session, baseline, 0)));

    const malformed = structuredClone(snapshot);
    (malformed.battle!.state as Record<string, any>).databaseHash = "0".repeat(64);
    expect(() => restoreSessionSnapshot(session, malformed)).toThrow("database hash");
  });

  for (const hz of [60, 30, 20]) test(`active battle rewind refolds actor and battle state at ${hz} Hz`, () => {
    const db = structuredClone(imported.battle);
    db.enemies[0]!.params[0] = 999;
    const project = battleProject();
    const makeController = (keyframes: boolean): AttractController => new AttractController(project, [], {
      hz,
      idleFrames: 60_000,
      rewindSeconds: 4 / hz,
      attractEnabled: false,
      keyframeMaxBytes: keyframes ? 2 * 1024 * 1024 : 0,
      keyframeMaxCount: keyframes ? 64 : 0,
      ...options(db),
    });

    const keyed = makeController(true);
    const prefix: number[] = [];
    for (let frame = 0; frame < 500; frame++) {
      const battle = keyed.state.scene?.kind === "battle"
        ? rpgMakerBattleState(keyed.state.scene.state)
        : null;
      if (battle?.phase === "command") break;
      const mask = frame % 2 === 0 ? CIRCLE : 0;
      keyed.step(mask);
      prefix.push(mask);
    }
    expect(keyed.state.scene?.kind).toBe("battle");
    expect(rpgMakerBattleState(keyed.state.scene!.state).phase).toBe("command");

    const fromZero = makeController(false);
    for (const mask of prefix) fromZero.step(mask);
    expect(keyed.state).toEqual(fromZero.state);
    const target = structuredClone(keyed.state);
    expect((target.ext as Record<string, any>).rpgmakerBattle.actors["1"]).toMatchObject({
      hp: 415,
      states: [{ id: 3, turns: 3 }],
    });
    expect((target.ext as Record<string, any>).rpgmakerBattle.actors["1"].equips[0])
      .toEqual({ kind: "weapon", id: 2 });

    const suffix = [0, CIRCLE, 0, 0];
    for (const mask of suffix) keyed.step(mask);
    const forward = structuredClone(keyed.state);
    expect(rpgMakerBattleState(forward.scene!.state).phase).toBe("message");
    expect(forward).not.toEqual(target);

    keyed.step(LTRIGGER);
    expect(keyed.status().rewound).toBe(true);
    expect(keyed.length).toBe(prefix.length);
    expect(keyed.state).toEqual(target);
    for (const mask of suffix) keyed.step(mask);
    expect(keyed.state).toEqual(forward);
  });

  for (const hz of [60, 30, 20]) test(`win executes 601, rewards, drops, and levels at ${hz} Hz`, () => {
    const db = structuredClone(imported.battle);
    db.skills.push({ ...structuredClone(db.skills[0]!), id: 2, name: "Second Wind" });
    db.classes[0]!.learnings.push({ level: 2, skillId: 2 });
    db.enemies[0]!.params[0] = 1;
    db.enemies[0]!.exp = 200;
    db.enemies[0]!.gold = 37;
    db.enemies[0]!.drops = [{ kind: 1, dataId: 1, denominator: 1, item: "item001" }];
    const project = battleProject();
    const session = createSession(project, hz, options(db));
    let state = enterBattle(session, startSession(project, session));
    state = settleEvent(session, finishBattle(session, state, "win"));

    expect(state.sw.switches.s010).toBe(true);
    expect(state.sw.variables.v005).toBe(100);
    expect(state.sw.gold).toBe(137);
    expect(state.sw.items.item001).toBe(1);
    expect((state.ext as Record<string, any>).rpgmakerBattle.actors["1"].level).toBeGreaterThan(1);
    expect((state.ext as Record<string, any>).rpgmakerBattle.actors["1"].skills).toContain(2);
  });

  test("escape executes the imported 602 branch", () => {
    const db = structuredClone(imported.battle);
    db.enemies[0]!.params[6] = 1;
    const project = battleProject();
    const session = createSession(project, 60, options(db));
    let state = enterBattle(session, startSession(project, session));
    state = settleEvent(session, finishBattle(session, state, "escape"));

    expect(state.sw.variables.v006).toBe(1);
    expect(state.sw.switches.s010).not.toBe(true);
    expect((state.ext as Record<string, any>).rpgmakerBattle.escapeCount).toBe(1);
  });

  test("allowed defeat executes the imported 603 branch without Game Over", () => {
    const db = structuredClone(imported.battle);
    db.enemies[0]!.params[2] = 999;
    const project = battleProject();
    const session = createSession(project, 60, options(db, lowHpExtension()));
    let state = enterBattle(session, startSession(project, session));
    state = settleEvent(session, finishBattle(session, state, "lose"));

    expect(state.sw.variables.v007).toBe(1);
    expect(state.sw.switches.s010).not.toBe(true);
    expect((state.ext as Record<string, any>).rpgmakerBattle.actors["1"].hp).toBe(1);
    expect((state.ext as Record<string, any>).rpgmakerBattle.actors["1"].states).toEqual([]);
  });

  test("a disallowed defeat always requests Game Over instead of a malformed 603 branch", async () => {
    const raw = loadRmProject(HOLLOW);
    const command = raw.maps.get(3)!.events[2]!.pages[0]!.list.find((entry) => entry.code === 301)!;
    command.parameters = [0, 1, true, false];
    const generated = await importRmProject(raw);
    const db = structuredClone(generated.battle);
    db.enemies[0]!.params[2] = 999;
    const project = battleProject(generated.project);
    const session = createSession(project, 60, options(db, lowHpExtension()));
    let state = enterBattle(session, startSession(project, session));
    state = settleEvent(session, finishBattle(session, state, "lose"));

    expect(state.interp.hostActions).toContain("gameOver");
    expect(state.sw.variables.v007).toBeUndefined();
  });

  test("a completed player step raises and consumes a region-filtered random encounter", async () => {
    const raw = loadRmProject(HOLLOW);
    raw.maps.get(1)!.encounterStep = 1;
    raw.maps.get(1)!.encounterList = [{ troopId: 1, weight: 1, regionSet: [7] }];
    const generated = await importRmProject(raw);
    const project = structuredClone(generated.project);
    const map = project.maps.find((entry) => entry.id === "map001")!;
    const encounterEvent = map.events!.find((event) => event.id === "rmi-random-encounter")!;
    const floor = map.ground[0]!;
    Object.assign(map, {
      width: 4,
      height: 4,
      ground: Array(16).fill(floor),
      upper: [],
      regions: [[1 * 4 + 2, 7]],
      events: [encounterEvent],
      passage: [],
    });
    delete map.vehiclePassage;
    project.maps = [map];
    delete project.vehicles;
    delete project.followers;
    project.start = { map: "map001", x: 1, y: 1, dir: "right" };
    const session = createSession(project, 60, options(generated.battle));
    let state = startSession(project, session);
    for (let frame = 0; frame < 20 && state.scene === null; frame++) {
      state = stepSession(session, state, { buttons: (state.sw.steps ?? 0) === 0 ? RIGHT : 0 });
    }

    expect(state.sw.steps).toBe(1);
    expect(state.sw.variables["rmi-encounter-due"]).toBe(1);
    expect(state.scene?.kind).toBe("battle");
    expect(rpgMakerBattleState(state.scene!.state).troopId).toBe(1);
    expect((state.ext as Record<string, any>).rpgmakerBattle.encounter)
      .toEqual({ map: "map001", remaining: 1 });
  });
});
