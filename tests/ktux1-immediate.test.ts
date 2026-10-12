import { describe, expect, test } from "bun:test";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type {
  Command,
  GameEvent,
  MapDef,
  Page,
  Project,
  TileId,
} from "../src/engine/types.ts";

const TILE: TileId = "tiles.0";

function page(trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page {
  return { trigger, sprite: null, commands, ...extra };
}

function event(id: string, x: number, y: number, pages: Page[]): GameEvent {
  return { id, x, y, pages };
}

function project(events: GameEvent[]): Project {
  const map: MapDef = {
    id: "field",
    name: "Field",
    width: 8,
    height: 6,
    sheets: ["tiles"],
    ground: new Array<TileId>(48).fill(TILE),
    events,
  };
  return {
    format: "rpgkit-project/v1",
    title: "Immediate scripted motion",
    tileSize: 16,
    start: { map: "field", x: 2, y: 2, dir: "down" },
    sheets: [{ id: "tiles", pak: "chunks", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [map],
  };
}

function controller(commands: Command[]): GameEvent {
  return event("controller", 2, 3, [page("action", commands)]);
}

function boot(p: Project, hz = 60): { session: Session; state: SessionState } {
  const session = createSession(p, hz);
  return { session, state: startSession(p, session) };
}

function action(session: Session, state: SessionState): SessionState {
  return stepSession(session, state, { buttons: 0, confirmEdge: true });
}

describe("additive immediate scripted facing and route startup", () => {
  test("face is rendered now and a later condition in the same fold reads it", () => {
    const p = project([controller([
      { op: "face", target: "player", dir: "right" },
      {
        op: "if",
        if: { kind: "facing", dir: "right" },
        then: [{ op: "switch", id: "saw-right", value: true }],
      },
    ])]);
    const run = boot(p);
    const out = action(run.session, run.state);
    expect(out.move).toMatchObject({ facing: 3, stepDir: 3, moving: false });
    expect(out.sw.switches["saw-right"]).toBe(true);
  });

  test("start immediate consumes the first route step while an omitted field stays delayed", () => {
    const command = (immediate: boolean): Command => ({
      op: "moveRoute",
      target: "player",
      wait: false,
      ...(immediate ? { start: "immediate" as const } : {}),
      route: { steps: ["moveRight"], repeat: false, skippable: false },
    });
    const legacy = boot(project([controller([command(false)])]));
    const delayed = action(legacy.session, legacy.state);
    expect(delayed.move).toMatchObject({ tx: 2, phase: 0, moving: false });
    expect(delayed.playerRoute).toMatchObject({ pc: 0 });

    const additive = boot(project([controller([command(true)])]));
    const started = action(additive.session, additive.state);
    expect(started.move).toMatchObject({ tx: 2, facing: 3, moving: true });
    expect(started.move.px).toBeGreaterThan(32);
    expect(started.playerRoute).toMatchObject({ pc: 1 });
  });

  test("a scripted turn captures a newly eligible facing-gated playerTouch edge", () => {
    const mat = event("mat", 2, 2, [page("playerTouch", [
      { op: "switch", id: "mat-fired", value: true },
    ], { condition: { all: [{ kind: "facing", dir: "up" }] } })]);
    const run = boot(project([
      controller([{ op: "face", target: "player", dir: "up" }]),
      mat,
    ]));
    let out = action(run.session, run.state);
    expect(out.interp.main?.key).toBe("field/mat");
    expect(out.sw.switches["mat-fired"]).toBeUndefined();
    out = stepSession(run.session, out, { buttons: 0 });
    expect(out.sw.switches["mat-fired"]).toBe(true);
  });

  test("a blocked immediate first step captures its eventTouch contact", () => {
    const blocker = event("blocker", 3, 2, [page("eventTouch", [
      { op: "switch", id: "bumped", value: true },
    ], { blocks: true })]);
    const run = boot(project([
      controller([{
        op: "moveRoute",
        target: "player",
        wait: false,
        start: "immediate",
        route: { steps: ["moveRight"], repeat: false, skippable: true },
      }]),
      blocker,
    ]));
    let out = action(run.session, run.state);
    expect(out.move).toMatchObject({ tx: 2, ty: 2, moving: false, facing: 3 });
    expect(out.interp.main?.key).toBe("field/blocker");
    out = stepSession(run.session, out, { buttons: 0 });
    expect(out.sw.switches.bumped).toBe(true);
  });

  test("equal reference-tick budgets settle identically at 60, 30, and 20 Hz", () => {
    const p = project([controller([{
      op: "moveRoute",
      target: "player",
      wait: false,
      start: "immediate",
      route: { steps: ["moveRight", "moveDown"], repeat: false, skippable: false },
    }])]);
    const outcomes = ([60, 30, 20] as const).map((hz) => {
      const run = boot(p, hz);
      let out = action(run.session, run.state);
      const elapsed = run.session.ticksPerFrame;
      for (let ticks = elapsed; ticks < 24; ticks += run.session.ticksPerFrame) {
        out = stepSession(run.session, out, { buttons: 0 });
      }
      return { move: out.move, route: out.playerRoute, frame: out.interp.frame };
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
  });
});
