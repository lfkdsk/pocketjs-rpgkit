import { describe, expect, test } from "bun:test";
import {
  createInterpState,
  createSwitchState,
  createWorld,
  stepInterp,
  type InterpInput,
  type TextModal,
} from "../src/engine/interpreter.ts";
import { createAutosaveSessionSnapshot } from "../src/engine/save.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import { createSession, startSession, stepSession } from "../src/engine/session.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

const RAW = String.raw`\C[2]\N[1]` + "😀" + String.raw`/\N[2]/\P[1]/\P[2]/\V[3]\G\C[0]!`;
const VISIBLE = "Aster😀/Magi/Magi/Aster/7G!";

function map(commands: Command[]): MapDef {
  const event: GameEvent = {
    id: "message",
    x: 1,
    y: 1,
    pages: [{ trigger: "autorun", commands }],
  };
  return {
    id: "text",
    name: "Text",
    width: 3,
    height: 3,
    sheets: ["floor"],
    ground: Array(9).fill("floor.0"),
    events: [event],
  };
}

const input: InterpInput = {
  playerCell: { x: 1, y: 1 },
  prevCell: { x: 1, y: 1 },
  facing: 0,
};

function bank() {
  return createSwitchState({
    playerName: "Aster",
    variables: { "actor002-name": "Magi", v003: 7 },
  });
}

describe("RPG Maker text in the interpreter", () => {
  test("opens a visible-only typewriter modal with actor, party, variable and colour state", () => {
    const world = createWorld(map([{ op: "text", lines: [RAW] }]), [], 60, {
      rpgMakerText: {
        actors: [
          { databaseId: 1, name: "Hero" },
          { databaseId: 2, name: "Mage" },
        ],
        partyActorIds: [2, 1],
        currencyUnit: "G",
      },
    });
    const state = stepInterp(world, createInterpState(bank()), input);
    const modal = state.modal as TextModal;
    const beforeBang = Array.from(VISIBLE.slice(0, -1)).length;

    expect(modal.lines).toEqual([VISIBLE]);
    expect(modal.total).toBe(Array.from(VISIBLE).length);
    expect(modal.colours).toEqual([
      { start: 0, end: beforeBang, colour: "#FF784C" },
      { start: beforeBang, end: beforeBang + 1, colour: "#FFFFFF" },
    ]);
  });

  test("is explicitly opt-in and does not mix with kit brace-token expansion", () => {
    const raw = String.raw`{name} \N[1]`;
    const plain = createWorld(map([{ op: "text", lines: [raw] }]), [], 60);
    const legacy = stepInterp(plain, createInterpState(bank()), input).modal as TextModal;
    expect(legacy.lines).toEqual([String.raw`Aster \N[1]`]);

    const rpg = createWorld(map([{ op: "text", lines: [raw] }]), [], 60, {
      rpgMakerText: {
        actors: [{ databaseId: 1, name: "Hero" }],
        partyActorIds: [1],
        currencyUnit: "G",
      },
    });
    const opted = stepInterp(rpg, createInterpState(bank()), input).modal as TextModal;
    expect(opted.lines).toEqual(["{name} Aster"]);
  });
});

function project(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "RPG Maker text",
    tileSize: 16,
    start: { map: "text", x: 1, y: 1, dir: "down" },
    system: {
      rpgMakerText: { party: [2, 1], currencyUnit: "G" },
    },
    actors: [
      { id: "hero", databaseId: 1, name: "Hero" },
      { id: "mage", databaseId: 2, name: "Mage" },
    ],
    sheets: [{ id: "floor", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [map([{ op: "text", lines: [RAW] }])],
  };
}

describe("RPG Maker text session determinism", () => {
  test("60/30/20 Hz expose identical modal content and reveal after the same virtual time", () => {
    const results: unknown[] = [];
    for (const hz of [60, 30, 20]) {
      const source = project();
      const session = createSession(source, hz);
      let state = startSession(source, session, bank());
      for (let frame = 0; frame < hz / 10; frame++) {
        state = stepSession(session, state, { buttons: 0 });
      }
      const modal = state.interp.modal as TextModal;
      expect(modal.colours, `${hz} Hz keeps colour spans after reveal ticks`).toBeDefined();
      results.push({
        lines: modal.lines,
        total: modal.total,
        revealed: modal.revealed,
        complete: modal.complete,
        colours: modal.colours,
      });
    }
    expect(results).toEqual([results[0], results[0], results[0]]);
  });

  test("autosave validation accepts canonical spans and rejects malformed colour state", () => {
    const source = project();
    const session = createSession(source);
    const opened = stepSession(session, startSession(source, session, bank()), { buttons: 0 });
    const snapshot = createAutosaveSessionSnapshot(session, opened, 0)!;
    expect(validateSnapshot(snapshot)).toBeNull();

    (snapshot.interp.modal as unknown as { colours: { start: number; end: number; colour: string }[] }).colours = [
      { start: 0, end: 1, colour: "#ff0000" },
    ];
    expect(validateSnapshot(snapshot)).toContain("uppercase six-digit hex colour");
  });
});
