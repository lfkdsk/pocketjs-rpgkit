import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { AttractController } from "../src/engine/attract.ts";
import { createSessionSnapshot, encodeEnvelope } from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { travelRuntime } from "../src/travel.ts";
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
import schema from "../src/data/schema.json";

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
  const session = createSession(p, hz, { travel: travelRuntime });
  return { session, state: startSession(p, session) };
}

function action(session: Session, state: SessionState): SessionState {
  return stepSession(session, state, { buttons: 0, confirmEdge: true });
}

function settle(session: Session, state: SessionState): SessionState {
  let out = state;
  for (let i = 0; i < 100 && out.move.moving; i++) {
    out = stepSession(session, out, { buttons: 0 });
  }
  return out;
}

describe("additive immediate scripted facing and route startup", () => {
  test("schema accepts the additive command/field and rejects malformed values", () => {
    const valid = project([controller([
      { op: "face", target: "this", dir: "left" },
      {
        op: "moveRoute",
        target: "player",
        start: "immediate",
        route: { steps: ["moveRight"], repeat: false, skippable: false },
      },
    ])]);
    expect(validateSchema(schema, valid)).toEqual([]);
    const badFace = structuredClone(valid) as any;
    badFace.maps[0].events[0].pages[0].commands[0].dir = "sideways";
    expect(validateSchema(schema, badFace).length).toBeGreaterThan(0);
    const badStart = structuredClone(valid) as any;
    badStart.maps[0].events[0].pages[0].commands[1].start = "now";
    expect(validateSchema(schema, badStart).length).toBeGreaterThan(0);
  });

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

  test("an immediate route uses its newly latched exact or grade speed on the first tick", () => {
    const cases = [
      { actor: "player" as const, exact: true, origin: 32, pixelsPerTick: 2.4 },
      { actor: "player" as const, exact: false, origin: 32, pixelsPerTick: 4 },
      { actor: "event" as const, exact: true, origin: 96, pixelsPerTick: 2.4 },
      { actor: "event" as const, exact: false, origin: 96, pixelsPerTick: 4 },
    ];
    for (const c of cases) {
      const target = c.actor === "player" ? "player" as const : { event: "runner" } as const;
      const speed = c.exact
        ? { kind: "routeSpeed" as const, value: 2 as const, tilesPerSecond: 9 }
        : { kind: "routeSpeed" as const, value: 6 as const };
      const p = project([
        controller([
          { op: "moveControl", target, control: speed },
          {
            op: "moveRoute",
            target,
            wait: false,
            start: "immediate",
            route: { steps: ["moveRight"], repeat: false, skippable: false },
          },
        ]),
        event("runner", 6, 4, [page("action", [], { moveSpeed: 1 })]),
      ]);
      const firstFrames = ([60, 30, 20] as const).map((hz) => {
        const run = boot(p, hz);
        const out = action(run.session, run.state);
        const mover = c.actor === "player" ? out.move : out.chars.chars.runner!;
        const phase = c.actor === "player" ? out.playerRoute?.phase : mover.phase;
        expect(phase, `${c.actor} ${c.exact ? "exact" : "grade"} at ${hz} Hz`).toBe(
          run.session.ticksPerFrame,
        );
        expect(mover.px).toBe(c.origin + c.pixelsPerTick * run.session.ticksPerFrame);
        if (c.exact) expect(mover.stepTilesPerSecond).toBe(9);
        else expect(mover.stepTilesPerSecond).toBeUndefined();
        return mover.px;
      });
      expect(firstFrames).toEqual([
        c.origin + c.pixelsPerTick,
        c.origin + c.pixelsPerTick * 2,
        c.origin + c.pixelsPerTick * 3,
      ]);
    }
  });

  test("face this changes the live event sprite in the issuing tick", () => {
    const run = boot(project([controller([{ op: "face", target: "this", dir: "left" }])]));
    const out = action(run.session, run.state);
    expect(out.chars.chars.controller).toMatchObject({ facing: 1, stepDir: 1 });
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

  test("exact-speed immediate routes settle identically at 60, 30, and 20 Hz", () => {
    const p = project([
      controller([
        {
          op: "moveControl",
          target: { event: "runner" },
          control: { kind: "routeSpeed", value: 2, tilesPerSecond: 9 },
        },
        {
          op: "moveRoute",
          target: { event: "runner" },
          wait: false,
          start: "immediate",
          route: { steps: ["moveRight", "moveDown"], repeat: false, skippable: false },
        },
      ]),
      event("runner", 1, 4, [page("action", [], { moveSpeed: 1 })]),
    ]);
    const outcomes = ([60, 30, 20] as const).map((hz) => {
      const run = boot(p, hz);
      let out = action(run.session, run.state);
      const elapsed = run.session.ticksPerFrame;
      for (let ticks = elapsed; ticks < 24; ticks += run.session.ticksPerFrame) {
        out = stepSession(run.session, out, { buttons: 0 });
      }
      return { char: out.chars.chars.runner, frame: out.interp.frame };
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
  });

  test("an immediate leader step records the breadcrumb and starts a stationary follower once", () => {
    const trigger = event("controller", 5, 2, [page("action", [{
      op: "moveRoute",
      target: "player",
      wait: false,
      start: "immediate",
      route: { steps: ["moveDown"], repeat: false, skippable: false },
    }])]);
    const p = project([trigger]);
    p.followers = { enabled: true, members: [{ id: "friend", sprite: "friend" }] };
    const run = boot(p);
    let out = settle(run.session, stepSession(run.session, run.state, { buttons: BTN.RIGHT }));
    out = settle(run.session, stepSession(run.session, out, { buttons: BTN.RIGHT }));
    expect(out.travel?.followers?.members[0]).toMatchObject({
      move: { tx: 3, ty: 2, moving: false },
      trail: [],
    });
    out = action(run.session, out);
    expect(out.move).toMatchObject({ tx: 4, ty: 2, facing: 0, moving: true });
    expect(out.travel?.followers?.members[0]).toMatchObject({
      move: { tx: 3, ty: 2, facing: 3, moving: true, phase: 1 },
      trail: [{ x: 4, y: 2 }],
    });
  });

  test("a ridden vehicle is resynchronized after a tick-tail immediate step", () => {
    const driver = event("driver", 0, 0, [
      page("autorun", [
        {
          op: "moveRoute",
          target: "player",
          wait: false,
          start: "immediate",
          route: { steps: ["moveRight"], repeat: false, skippable: false },
        },
        { op: "selfSwitch", key: "A", value: true },
      ]),
      page("parallel", [], { condition: { selfSwitch: "A" } }),
    ]);
    const p = project([driver]);
    p.vehicles = [{
      id: "airship",
      kind: "airship",
      sprite: "airship",
      start: { map: "field", x: 2, y: 2, dir: "down" },
    }];
    const run = boot(p);
    const vehicles = run.state.travel!.vehicles!;
    vehicles.riding = "airship";
    vehicles.airshipPhase = "cruising";
    vehicles.airshipAltitude = 16;
    const out = stepSession(run.session, run.state, { buttons: 0 });
    const airship = out.travel?.vehicles?.entries.find((entry) => entry.id === "airship");
    expect(out.move.moving).toBe(true);
    expect(airship).toMatchObject({ mapId: "field", move: out.move });
  });

  test("an exact-speed immediate route starts correctly, then saves and resumes byte-identically", () => {
    const runner = event("runner", 1, 4, [page("action", [])]);
    const p = project([
      controller([
        {
          op: "moveControl",
          target: { event: "runner" },
          control: { kind: "routeSpeed", value: 2, tilesPerSecond: 9 },
        },
        {
          op: "moveRoute",
          target: { event: "runner" },
          wait: false,
          start: "immediate",
          route: { steps: ["moveRight", "moveDown"], repeat: false, skippable: false },
        },
      ]),
      runner,
    ]);
    const run = boot(p);
    let live = action(run.session, run.state);
    expect(live.chars.chars.runner).toMatchObject({ phase: 1, moving: true, stepTilesPerSecond: 9 });
    expect(live.chars.chars.runner?.px).toBe(18.4);
    live = stepSession(run.session, live, { buttons: 0 });
    const restored = restoreSessionEnvelope(
      run.session,
      encodeEnvelope(createSessionSnapshot(run.session, live, 0), run.session.content),
    );
    let resumed = restored;
    for (let i = 0; i < 20; i++) {
      live = stepSession(run.session, live, { buttons: 0 });
      resumed = stepSession(run.session, resumed, { buttons: 0 });
    }
    expect(resumed).toEqual(live);
  });

  test("rewind restores the state before an immediate route began", () => {
    const p = project([controller([
      {
        op: "moveControl",
        target: "player",
        control: { kind: "routeSpeed", value: 2, tilesPerSecond: 9 },
      },
      {
        op: "moveRoute",
        target: "player",
        wait: false,
        start: "immediate",
        route: { steps: ["moveRight", "moveRight"], repeat: false, skippable: false },
      },
    ])]);
    const attract = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      idleFrames: 60_000,
      rewindSeconds: 0.25,
    });
    attract.step(BTN.CIRCLE);
    for (let i = 0; i < 10; i++) attract.step(0);
    expect(attract.state.move.px).toBeGreaterThan(32);
    attract.step(BTN.LTRIGGER);
    expect(attract.rewound).toBe(true);
    expect(attract.state.move).toMatchObject({ tx: 2, ty: 2, px: 32, py: 32, facing: 0, moving: false });
    expect(attract.state.playerRoute).toBeNull();
  });
});
