// tests/message-blocks-player.test.ts — Project.system.messageBlocksPlayer.
//
// With the option set, an open text/choices box of ANY fiber — a PARALLEL
// page's included — holds the player: the d-pad moves nothing and no
// action/playerTouch page starts, while autorun and parallel pages keep
// folding. Without it the v1 rule stands (only a blocking fiber or a
// choices box holds the player), and the v1 cases below pin that.
//
// The fixture is a bedroom whose map-entry intro runs on a parallel page
// (the shape an importer gives automatic cutscenes), a bed the player can
// face, and stairs that transfer away. Pure bun: folds the session reducer.

import { describe, expect, test } from "bun:test";
import { BTN_BITS } from "../src/engine/camera.ts";
import { createChars } from "../src/engine/chars.ts";
import {
  createInterpState,
  createWorld,
  messageHoldsPlayer,
  stepInterp,
  type InterpInput,
} from "../src/engine/interpreter.ts";
import { buildPassage } from "../src/engine/passability.ts";
import { createSnapshot, decodeEnvelopeText, encodeEnvelope } from "../src/engine/save.ts";
import { restoreProblem } from "../src/engine/save-restore.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../src/engine/session.ts";
import type { Command, Dir, GameEvent, MapDef, Page, Project, TileId } from "../src/engine/types.ts";

const GRASS: TileId = "town.0";
const { UP, LEFT } = BTN_BITS;

function room(id: string, w: number, h: number, events: GameEvent[]): MapDef {
  return {
    id, name: id, width: w, height: h, sheets: ["town"],
    ground: new Array(w * h).fill(GRASS), events,
  };
}
function ge(id: string, x: number, y: number, pages: Page[]): GameEvent {
  return { id, x, y, pages };
}
function pg(trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page {
  return { trigger, sprite: null, commands, ...extra };
}

interface HomeOptions {
  /** Project.system.messageBlocksPlayer; undefined leaves `system` out. */
  messageBlocksPlayer?: boolean;
  /** Virtual seconds the intro waits before its first line. */
  delay?: number;
  start?: { x: number; y: number; dir: Dir };
  extra?: GameEvent[];
}

/** A 9×7 bedroom. The intro is a PARALLEL page: two lines, a skip prompt,
 *  and a two-line speech on "No"; setting intro=1 retires the page. The bed
 *  at (1,2) is an action page with a body; the stairs at (4,1) are a
 *  playerTouch transfer. */
function home(opts: HomeOptions = {}): Project {
  const intro = ge("intro", 0, 0, [pg("parallel", [
    ...(opts.delay ? [{ op: "wait", seconds: opts.delay } as Command] : []),
    { op: "text", lines: ["Good morning!", "Mom is calling you."] },
    {
      op: "choices",
      prompt: "Skip the intro?",
      options: [
        { text: "No", commands: [
          { op: "text", lines: ["The CEO speaks at length."] },
          { op: "text", lines: ["...and at more length."] },
        ] },
        { text: "Yes", commands: [] },
      ],
    },
    { op: "variable", id: "intro", set: { op: "set", value: 1 } },
  ], { condition: { variable: { id: "intro", op: "==", value: 0 } } })]);
  const bed = ge("bed", 1, 2, [pg("action", [
    { op: "variable", id: "rested", set: { op: "add", value: 1 } },
    { op: "text", lines: ["Resting in bed..."] },
  ], { sprite: "bed", blocks: true })]);
  const stairs = ge("stairs", 4, 1, [pg("playerTouch", [
    { op: "transfer", map: "downstairs", x: 1, y: 1, dir: "down" },
  ])]);
  const p: Project = {
    format: "rpgkit-project/v1",
    title: "t",
    tileSize: 16,
    start: { map: "home", ...(opts.start ?? { x: 4, y: 4, dir: "down" }) },
    sheets: [{ id: "town", cols: 12, rows: 11, defaultPassage: "pass" }],
    items: [],
    maps: [
      room("home", 9, 7, [intro, bed, stairs, ...(opts.extra ?? [])]),
      room("downstairs", 4, 4, []),
    ],
  };
  if (opts.messageBlocksPlayer !== undefined) p.system = { messageBlocksPlayer: opts.messageBlocksPlayer };
  return p;
}

function boot(p: Project, hz = 60): { sess: Session; s: SessionState } {
  const sess = createSession(p, hz);
  return { sess, s: startSession(p, sess) };
}

function step(sess: Session, s: SessionState, input: SessionInput = { buttons: 0 }): SessionState {
  return stepSession(sess, s, input);
}

const pos = (s: SessionState) => ({
  map: s.mapId, tx: s.move.tx, ty: s.move.ty, px: s.move.px, py: s.move.py, facing: s.move.facing,
});

/** Answer every open box with a confirm on alternate frames (the first
 *  press finishes the typewriter, the next closes it; "No" at the prompt)
 *  while `buttons` stays held, until the intro retires itself. `each` sees
 *  every folded state. */
function answerIntro(
  sess: Session,
  s0: SessionState,
  buttons: number,
  each: (s: SessionState) => void = () => {},
): SessionState {
  let s = s0;
  for (let f = 0; f < 600 && s.sw.variables["intro"] !== 1; f++) {
    s = step(sess, s, { buttons, confirmEdge: s.interp.modal !== null && f % 2 === 0 });
    each(s);
  }
  expect(s.sw.variables["intro"]).toBe(1);
  return s;
}

describe("messageBlocksPlayer — a parallel page's box holds the player", () => {
  test("holding a direction while the intro's box is open leaves the player on its tile", () => {
    const { sess, s: s0 } = boot(home({ messageBlocksPlayer: true }));
    let s = step(sess, s0); // the parallel intro opens its first line
    expect(s.interp.modal).toMatchObject({ kind: "text", fiber: "home/intro" });
    expect(s.interp.main).toBeNull(); // no blocking fiber: only the box holds
    const at = pos(s);
    for (let f = 0; f < 90; f++) {
      s = step(sess, s, { buttons: LEFT });
      expect(pos(s)).toEqual(at);
    }
    expect(s.interp.modal?.fiber).toBe("home/intro");

    // Through the prompt and the speech the held d-pad still moves nothing.
    s = answerIntro(sess, s, LEFT, (st) => {
      if (st.interp.modal) expect(pos(st)).toEqual(at);
    });
    // The box is gone: the same hold walks the player to the west wall.
    s = step(sess, s, { buttons: LEFT });
    expect(s.move.moving).toBe(true);
    for (let f = 0; f < 40; f++) s = step(sess, s, { buttons: LEFT });
    expect(pos(s)).toMatchObject({ tx: 0, ty: 4 });
  });

  test("v1 (option absent or false): the held direction walks out from under the open box", () => {
    for (const p of [home(), home({ messageBlocksPlayer: false })]) {
      const { sess, s: s0 } = boot(p);
      let s = step(sess, s0);
      for (let f = 0; f < 40; f++) s = step(sess, s, { buttons: LEFT });
      expect(pos(s)).toMatchObject({ tx: 0, ty: 4 });
      expect(s.interp.modal?.fiber).toBe("home/intro");
    }
  });

  test("the confirm that advances the box never starts the faced bed", () => {
    const { sess, s: s0 } = boot(home({ messageBlocksPlayer: true, start: { x: 1, y: 3, dir: "up" } }));
    let s = step(sess, s0);
    expect(s.interp.modal?.fiber).toBe("home/intro");
    s = answerIntro(sess, s, 0, (st) => {
      expect(st.interp.main).toBeNull();
      expect(st.sw.variables["rested"] ?? 0).toBe(0);
    });
    expect(s.interp.modal).toBeNull();
    // With no box open the next press talks to the bed as usual.
    s = step(sess, s, { buttons: 0, confirmEdge: true });
    expect(s.interp.main?.key).toBe("home/bed");
    expect(s.sw.variables["rested"]).toBe(1);
  });

  test("v1: the same confirm also starts the bed behind the intro", () => {
    const { sess, s: s0 } = boot(home({ start: { x: 1, y: 3, dir: "up" } }));
    let s = step(sess, s0);
    s = step(sess, s, { buttons: 0, confirmEdge: true });
    expect(s.interp.modal?.fiber).toBe("home/intro"); // the press only finished the typewriter
    expect(s.interp.main?.key).toBe("home/bed");
    expect(s.sw.variables["rested"]).toBe(1);
  });

  test("the player cannot reach the stairs during the intro; afterwards the stairs work", () => {
    const { sess, s: s0 } = boot(home({ messageBlocksPlayer: true }));
    let s = step(sess, s0);
    s = answerIntro(sess, s, UP, (st) => {
      if (st.interp.modal) expect(pos(st)).toMatchObject({ map: "home", tx: 4, ty: 4 });
    });
    for (let f = 0; f < 40 && s.mapId === "home"; f++) s = step(sess, s, { buttons: UP });
    expect(s.mapId).toBe("downstairs");
    expect(s.sw.variables["intro"]).toBe(1);
  });

  test("v1: holding up walks onto the stairs mid-intro and skips the rest of it", () => {
    const { sess, s: s0 } = boot(home());
    let s = step(sess, s0);
    for (let f = 0; f < 40 && s.mapId === "home"; f++) s = step(sess, s, { buttons: UP });
    expect(s.mapId).toBe("downstairs");
    expect(s.sw.variables["intro"]).toBeUndefined();
  });

  test("autorun and parallel pages keep running while the box holds the player", () => {
    // A parallel clock counts while the intro box is open; once it reaches
    // 3 an autorun page starts (and runs) under the same open box.
    const clock = ge("clock", 8, 0, [pg("parallel", [
      { op: "wait", seconds: 0.1 },
      { op: "variable", id: "ticks", set: { op: "add", value: 1 } },
    ])]);
    const mom = ge("mom", 8, 6, [
      pg("autorun", [
        { op: "switch", id: "called", value: true },
        { op: "selfSwitch", key: "A", value: true },
      ], { condition: { variable: { id: "ticks", op: ">=", value: 3 } } }),
      pg("parallel", [], { condition: { selfSwitch: "A" } }),
    ]);
    const { sess, s: s0 } = boot(home({ messageBlocksPlayer: true, extra: [clock, mom] }));
    let s = step(sess, s0);
    const at = pos(s);
    for (let f = 0; f < 30; f++) s = step(sess, s, { buttons: LEFT });
    expect(s.interp.modal?.fiber).toBe("home/intro"); // never answered: still open
    expect(s.sw.variables["ticks"]).toBeGreaterThanOrEqual(3);
    expect(s.sw.switches["called"]).toBe(true);
    expect(s.sw.self["home/mom"]).toBe("A");
    expect(pos(s)).toEqual(at);
  });

  test("a playerTouch page does not start under an open box", () => {
    // Interpreter level: the only way the player enters a cell under a
    // held box is a forced route, so feed the entry edge directly.
    const map = room("v", 12, 8, [
      ge("talk", 0, 0, [pg("parallel", [{ op: "text", lines: ["A parallel line."] }])]),
      ge("mat", 5, 5, [pg("playerTouch", [{ op: "variable", id: "stepped", set: { op: "add", value: 1 } }])]),
    ]);
    const input = (cell: { x: number; y: number }, prev = cell): InterpInput => ({
      playerCell: cell, prevCell: prev, facing: 3,
    });
    for (const on of [true, false]) {
      const w = createWorld(map, [], 60, { messageBlocksPlayer: on });
      let s = stepInterp(w, createInterpState(), input({ x: 4, y: 5 }));
      expect(s.modal?.fiber).toBe("v/talk");
      expect(messageHoldsPlayer(w, s)).toBe(on);
      s = stepInterp(w, s, input({ x: 5, y: 5 }, { x: 4, y: 5 }));
      // v1 starts the mat (its one command runs and finishes this step).
      expect(s.sw.variables["stepped"] ?? 0).toBe(on ? 0 : 1);
      expect("v/mat" in s.touched).toBe(!on);
    }
  });
});

describe("messageBlocksPlayer — determinism", () => {
  /** The intro waits 31 reference ticks, so its first line opens on tick
   *  32, the tick the player (holding left from (8,4)) lands on (4,4). */
  const project = (): Project => home({
    messageBlocksPlayer: true,
    delay: 31 / 60,
    start: { x: 8, y: 4, dir: "left" },
  });

  /** Fold to reference tick `endTick` at `hz`, holding left throughout and
   *  pressing confirm on every host frame that starts on tick 30k+1
   *  (k >= 2): tick 30k+1 opens a batch at 60, 30, 20 and 4 Hz alike.
   *  Samples every 30 ticks. */
  function journey(hz: number, endTick: number) {
    const { sess, s: s0 } = boot(project(), hz);
    const n = 60 / hz;
    let s = s0;
    const samples: unknown[] = [];
    for (let tick = 0; tick < endTick; tick += n) {
      const confirmEdge = tick >= 60 && tick % 30 === 0;
      s = step(sess, s, { buttons: LEFT, confirmEdge });
      if ((tick + n) % 30 === 0) {
        const m = s.interp.modal;
        samples.push({
          tick: tick + n,
          ...pos(s),
          moving: s.move.moving,
          phase: s.move.phase,
          modal: m && (m.kind === "text"
            ? { kind: m.kind, fiber: m.fiber, revealed: m.revealed, complete: m.complete }
            : m.kind === "scrollText"
              ? { kind: m.kind, fiber: m.fiber, offset2: m.offset2 }
            : { kind: m.kind, fiber: m.fiber, index: m.index }),
          intro: s.sw.variables["intro"] ?? 0,
        });
      }
    }
    return samples as Array<Record<string, unknown>>;
  }

  test("the held player and the dialog agree at every 30-tick instant at 60/30/20/4 Hz", () => {
    const at60 = journey(60, 360);
    for (const hz of [30, 20, 4]) expect(journey(hz, 360), `${hz} Hz`).toEqual(at60);
    // What the agreed journey is: the box opens as the player lands on
    // (4,4), holds it there through tick 240, then the player walks on.
    const byTick = new Map(at60.map((x) => [x.tick, x]));
    expect(byTick.get(30)).toMatchObject({ tx: 5, modal: null });
    for (const t of [60, 90, 120, 150, 180, 210, 240]) {
      expect(byTick.get(t), `tick ${t}`).toMatchObject({ tx: 4, px: 64, moving: false });
      expect((byTick.get(t)!.modal as { fiber: string } | null)?.fiber, `tick ${t}`).toBe("home/intro");
    }
    expect(byTick.get(270)).toMatchObject({ intro: 1, modal: null, tx: 1 });
    expect(byTick.get(360)).toMatchObject({ tx: 0, px: 0 });
  });

  test("a save taken while the intro waits resumes into the same held dialog", () => {
    // The intro waits 25 ticks; the player idles 10 frames (a safe point:
    // resting, no box, the parallel parked in its wait), then holds left and
    // presses confirm every 30th frame.
    const p = home({ messageBlocksPlayer: true, delay: 25 / 60 });
    const input = (f: number): SessionInput => ({
      buttons: f > 10 ? LEFT : 0,
      confirmEdge: f > 40 && f % 30 === 0,
    });
    const { sess, s: s0 } = boot(p);
    let a = s0;
    for (let f = 1; f <= 10; f++) a = step(sess, a, input(f));
    expect(a.interp.parallels["home/intro"]?.mode).toBe("wait");

    const envelope = encodeEnvelope(createSnapshot(a.mapId, a.move, a.interp, 0));
    const snap = decodeEnvelopeText(envelope);
    const map = p.maps[0]!;
    const table = buildPassage(map, new Map(p.sheets.map((sh) => [sh.id, sh])));
    expect(restoreProblem(snap, map, table)).toBeNull();
    let b: SessionState = {
      frame: Math.floor(snap.interp.frame / sess.ticksPerFrame),
      mapId: snap.map,
      sw: snap.interp.sw,
      move: snap.player,
      chars: createChars(),
      interp: snap.interp,
      fade: null,
      playerRoute: null,
      ext: snap.ext,
      scene: null,
    };

    let heldFrames = 0;
    for (let f = 11; f <= 400; f++) {
      a = step(sess, a, input(f));
      b = step(sess, b, input(f));
      expect(pos(b), `frame ${f}`).toEqual(pos(a));
      expect(b.interp.modal, `frame ${f}`).toEqual(a.interp.modal);
      expect(b.sw, `frame ${f}`).toEqual(a.sw);
      if (b.interp.modal) {
        heldFrames++;
        // Holding left from (4,4): landed (3,4) and (2,4) as the box opened.
        expect(pos(b)).toMatchObject({ tx: 2, ty: 4, px: 32 });
      }
    }
    expect(heldFrames).toBeGreaterThan(100);
    expect(b.sw.variables["intro"]).toBe(1);
    expect(pos(b)).toMatchObject({ tx: 0, ty: 4 });
    expect(b).toEqual(a);
  });
});

describe("messageBlocksPlayer — schema", async () => {
  const schema = await Bun.file(new URL("../src/data/schema.json", import.meta.url)).json();
  const withSystem = (system: unknown): unknown => {
    const p = home() as unknown as Record<string, unknown>;
    (p.sheets as Array<Record<string, unknown>>)[0]!.pak = "tiles";
    p.system = system;
    return p;
  };

  test("accepts system.messageBlocksPlayer and an empty system block", () => {
    expect(validateSchema(schema, withSystem({ messageBlocksPlayer: true }))).toEqual([]);
    expect(validateSchema(schema, withSystem({ messageBlocksPlayer: false }))).toEqual([]);
    expect(validateSchema(schema, withSystem({}))).toEqual([]);
  });

  test("rejects a non-boolean value and unknown system keys", () => {
    expect(validateSchema(schema, withSystem({ messageBlocksPlayer: "yes" })).length).toBeGreaterThan(0);
    expect(validateSchema(schema, withSystem({ freezeOnText: true })).length).toBeGreaterThan(0);
  });
});
