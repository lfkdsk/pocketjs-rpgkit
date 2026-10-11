import { describe, expect, test } from "bun:test";
import {
  cloneModal,
  createInterpState,
  createSwitchState,
  createWorld,
  modalChanged,
  stepInterp,
  type ChoiceModal,
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

  test("keeps prompt and aligned option colours through cursor moves, cloning, and modal reinstall", () => {
    const prompt = String.raw`\C[1]` + "问😀" + String.raw`\C[0]?`;
    const first = String.raw`plain \C[2]` + "红😀" + String.raw`\C[0]` + "尾";
    const world = createWorld(map([{
      op: "choices",
      prompt,
      options: [
        { text: first, icon: { sprite: "hero" }, commands: [] },
        { text: "普通", commands: [] },
      ],
    }]), [], 60, {
      rpgMakerText: { actors: [], partyActorIds: [], currencyUnit: "G" },
    });
    let state = stepInterp(world, createInterpState(bank()), input);
    const modal = state.modal as ChoiceModal;
    expect(modal).toMatchObject({
      prompt: "问😀?",
      options: ["plain 红😀尾", "普通"],
      icons: [{ sprite: "hero" }, null],
      index: 0,
    });
    expect(modal.promptColours).toEqual([
      { start: 0, end: 2, colour: "#20A0D6" },
      { start: 2, end: 3, colour: "#FFFFFF" },
    ]);
    expect(modal.optionColours).toEqual([[
      { start: 6, end: 8, colour: "#FF784C" },
      { start: 8, end: 9, colour: "#FFFFFF" },
    ], null]);

    const cloned = cloneModal(modal) as ChoiceModal;
    expect(cloned).toEqual(modal);
    expect(cloned.promptColours).not.toBe(modal.promptColours);
    expect(cloned.promptColours![0]).not.toBe(modal.promptColours![0]);
    expect(cloned.optionColours).not.toBe(modal.optionColours);
    expect(cloned.optionColours![0]).not.toBe(modal.optionColours![0]);
    expect(cloned.optionColours![0]![0]).not.toBe(modal.optionColours![0]![0]);
    expect(modalChanged(modal, cloned)).toBe(false);

    const { promptColours: _promptColours, ...withoutPromptColours } = modal;
    expect(modalChanged(modal, withoutPromptColours)).toBe(true);
    const { optionColours: _optionColours, ...withoutOptionColours } = modal;
    expect(modalChanged(modal, withoutOptionColours)).toBe(true);

    const changedPrompt = cloneModal(modal) as ChoiceModal;
    changedPrompt.promptColours = [{ ...changedPrompt.promptColours![0]!, colour: "#010203" }];
    expect(modalChanged(modal, changedPrompt)).toBe(true);
    const changedOption = cloneModal(modal) as ChoiceModal;
    changedOption.optionColours = [[{ ...changedOption.optionColours![0]![0]!, end: 7 }], null];
    expect(modalChanged(modal, changedOption)).toBe(true);

    state = stepInterp(world, state, { ...input, downEdge: true });
    expect((state.modal as ChoiceModal).optionColours).toEqual(modal.optionColours);
    const rebuilt = stepInterp(world, { ...state, modal: null }, input);
    expect(rebuilt.modal).toMatchObject({
      kind: "choices",
      index: 0,
      promptColours: modal.promptColours,
      optionColours: modal.optionColours,
    });
  });

  test("keeps an extension choice prompt's text and colours as one open-box snapshot", () => {
    const source = project();
    source.maps[0]!.events![0]!.pages[0]!.commands = [{
      op: "extChoice",
      call: "test.live",
      args: null,
      prompt: String.raw`\C[1]Pick \V[3]`,
      cancel: true,
    }];
    const session = createSession(source, 60, { extensions: {
      choices: {
        "test.live": { options: () => [{ key: "a", label: "A", enabled: true, data: null }] },
      },
    } });
    let state = stepSession(session, startSession(source, session, bank()), { buttons: 0 });
    const opened = state.interp.modal as ChoiceModal;
    expect(opened.prompt).toBe("Pick 7");
    expect(opened.promptColours).toEqual([{ start: 0, end: 6, colour: "#20A0D6" }]);

    state.sw.variables.v003 = 99;
    state = stepSession(session, state, { buttons: 0 });
    expect(state.interp.modal).toMatchObject({
      kind: "choices",
      prompt: "Pick 7",
      promptColours: opened.promptColours,
    });
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

  test("choice save validation accepts canonical runs and rejects malformed prompt/option columns", () => {
    const source = project();
    source.maps[0]!.events![0]!.pages[0]!.commands = [{
      op: "choices",
      prompt: String.raw`\C[1]` + "问😀",
      options: [
        { text: String.raw`\C[2]` + "红😀", commands: [] },
        { text: "普通", commands: [] },
      ],
    }];
    const session = createSession(source);
    const opened = stepSession(session, startSession(source, session, bank()), { buttons: 0 });
    const clean = createAutosaveSessionSnapshot(session, opened, 0)!;
    expect(validateSnapshot(clean)).toBeNull();

    const withModal = () => structuredClone(clean);
    const lower = withModal();
    (lower.interp.modal as unknown as {
      promptColours: { start: number; end: number; colour: string }[];
    }).promptColours[0] = { start: 0, end: 1, colour: "#ff0000" };
    expect(validateSnapshot(lower)).toContain("uppercase six-digit hex colour");

    const overlap = withModal();
    (overlap.interp.modal as unknown as {
      optionColours: ({ start: number; end: number; colour: string }[] | null)[];
    }).optionColours[0] = [
      { start: 0, end: 2, colour: "#FF0000" },
      { start: 1, end: 2, colour: "#00FF00" },
    ];
    expect(validateSnapshot(overlap)).toContain("non-overlapping spans");

    const outOfRange = withModal();
    (outOfRange.interp.modal as unknown as {
      optionColours: ({ start: number; end: number; colour: string }[] | null)[];
    }).optionColours[0] = [
      { start: 0, end: 4, colour: "#FF0000" },
    ];
    expect(validateSnapshot(outOfRange)).toContain("offsets within total");

    const wrongLength = withModal();
    (wrongLength.interp.modal as unknown as { optionColours: null[] }).optionColours = [null];
    expect(validateSnapshot(wrongLength)).toContain("one span array or null per option");
  });
});
