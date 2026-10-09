// KM1 — runtime movement controls. These tests stay engine-only so the
// deterministic reducer contract is exercised independently of rendering.

import { describe, expect, test } from "bun:test";
import schema from "../src/data/schema.json" with { type: "json" };
import { AttractController } from "../src/engine/attract.ts";
import {
  createMoveControlState,
  frequencyDelay,
  movementConfigFor,
  movementConfigForTilesPerSecond,
} from "../src/engine/move-control.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import {
  createSessionSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
} from "../src/engine/save.ts";
import { restoreSessionSnapshot } from "../src/engine/save-restore.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import {
  createSession,
  isSessionWorldIdle,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type {
  Command,
  GameEvent,
  MapDef,
  MoveControl,
  MoveFrequency,
  Page,
  Project,
  TileId,
} from "../src/engine/types.ts";

const TILE: TileId = "tiles.0";
const BTN = { UP: 0x0010, RIGHT: 0x0020, DOWN: 0x0040, LEFT: 0x0080, L: 0x0100 } as const;

const page = (trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page => ({
  trigger,
  sprite: null,
  commands,
  ...extra,
});

const event = (id: string, x: number, y: number, pages: Page[]): GameEvent => ({ id, x, y, pages });

function map(
  id: string,
  events: GameEvent[] = [],
  passage?: Array<[number, "pass" | "block"]>,
  width = 10,
  height = 8,
): MapDef {
  return {
    id,
    name: id,
    width,
    height,
    sheets: ["tiles"],
    ground: new Array<TileId>(width * height).fill(TILE),
    events,
    ...(passage ? { passage } : {}),
  };
}

function project(
  maps: MapDef[],
  start: Project["start"] = { map: "a", x: 2, y: 2, dir: "down" },
): Project {
  return {
    format: "rpgkit-project/v1",
    title: "KM1",
    tileSize: 16,
    start,
    sheets: [{ id: "tiles", pak: "chunks", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps,
  };
}

function controller(commands: Command[], id = "controller"): GameEvent {
  return event(id, 2, 3, [page("action", commands)]);
}

function boot(p: Project, hz = 60): { session: Session; state: SessionState } {
  const session = createSession(p, hz);
  return { session, state: startSession(p, session) };
}

function action(session: Session, state: SessionState): SessionState {
  return stepSession(session, state, { buttons: 0, confirmEdge: true });
}

function fold(session: Session, state: SessionState, hostFrames: number, buttons = 0): SessionState {
  let out = state;
  for (let i = 0; i < hostFrames; i++) out = stepSession(session, out, { buttons });
  return out;
}

function foldReferenceTicks(
  session: Session,
  state: SessionState,
  referenceTicks: number,
  buttons = 0,
): SessionState {
  expect(referenceTicks % session.ticksPerFrame).toBe(0);
  return fold(session, state, referenceTicks / session.ticksPerFrame, buttons);
}

function controls(state: SessionState) {
  const value = state.interp.moveControls;
  if (!value) throw new Error("expected movement controls to be allocated");
  return value;
}

function motionProjection(state: SessionState): unknown {
  return {
    move: state.move,
    chars: state.chars,
    rng: state.sw.rng,
    controls: state.interp.moveControls,
    interpFrame: state.interp.frame,
  };
}

describe("KM1 schema and ordered dispatch", () => {
  const ALL_CONTROLS: MoveControl[] = [
    { kind: "wander", bounds: { x: 1, y: 2, width: 3, height: 4 }, frequency: 3, intervalTicks: 18 },
    { kind: "moveType", value: "page" },
    { kind: "stop" },
    { kind: "speed", value: 6 },
    { kind: "routeSpeed", value: 5, tilesPerSecond: 7 },
    { kind: "run", value: true },
    { kind: "frequency", value: 2 },
    { kind: "directionFix", value: true },
    { kind: "through", value: true },
    { kind: "facingMode", value: "scripted" },
  ];

  test("all controls, route controls, page defaults, and player place validate", () => {
    const commands: Command[] = ALL_CONTROLS.map((control) => ({
      op: "moveControl",
      target: "player",
      control,
    }));
    commands.push({
      op: "moveRoute",
      target: "this",
      route: {
        steps: ALL_CONTROLS.map((control) => ({ control })),
        repeat: false,
        skippable: true,
      },
    });
    commands.push({ op: "place", target: "player", x: 1, y: 1, dir: "right" });
    const p = project([map("a", [event("e", 1, 1, [page("action", commands, {
      moveSpeed: 4,
      moveFrequency: 2,
      directionFix: true,
      through: true,
      facingMode: "locked",
    })])])]);
    expect(validateSchema(schema, p)).toEqual([]);

    const bad = structuredClone(p) as Project;
    (bad.maps![0]!.events![0]!.pages[0]!.commands[0] as any).control.bounds.width = 0;
    expect(validateSchema(schema, bad).length).toBeGreaterThan(0);
  });

  test("player, this, and named event targets resolve without touching peers", () => {
    const named = event("named", 6, 5, [page("action", [])]);
    const p = project([map("a", [
      controller([
        { op: "moveControl", target: "player", control: { kind: "run", value: true } },
        { op: "moveControl", target: "this", control: { kind: "speed", value: 4 } },
        { op: "moveControl", target: { event: "named" }, control: { kind: "through", value: true } },
      ]),
      named,
    ])]);
    const { session, state } = boot(p);
    const out = action(session, state);
    expect(controls(out).player).toEqual({ running: true });
    expect(controls(out).events.controller).toEqual({ pageIndex: 0, speed: 4 });
    expect(controls(out).events.named).toEqual({ pageIndex: 0, through: true });
  });

  test("the legacy gate stays sparse yet arms a route's first control step", () => {
    const standalone = project([map("a", [controller([
      { op: "moveControl", target: "player", control: { kind: "speed", value: 6 } },
    ])])]);
    const direct = boot(standalone);
    expect(direct.session.worlds.get("a")?.needsMovementControlPath).toBe(false);
    expect(direct.state.interp.moveControls).toBeUndefined();
    const controlled = action(direct.session, direct.state);
    expect(controls(controlled).player.speed).toBe(6);

    const runner = event("runner", 1, 5, [page("action", [])]);
    const routed = project([map("a", [controller([{
      op: "moveRoute",
      target: { event: "runner" },
      route: {
        steps: [{ control: { kind: "speed", value: 6 } }, "moveRight"],
        repeat: false,
        skippable: false,
      },
    }]), runner])]);
    const run = boot(routed);
    expect(run.session.worlds.get("a")?.needsMovementControlPath).toBe(true);
    let out = action(run.session, run.state);
    expect(out.interp.moveControls).toBeUndefined();
    out = stepSession(run.session, out, { buttons: 0 });
    expect(controls(out).events.runner).toMatchObject({ pageIndex: 0, speed: 6 });
    out = fold(run.session, out, 4);
    expect(out.chars.chars.runner).toMatchObject({ tx: 2, ty: 5, moving: false });
  });

  test("route → stop → route drains in command order", () => {
    const route = (step: "moveRight" | "moveDown"): Command => ({
      op: "moveRoute",
      target: "player",
      wait: false,
      route: { steps: [step], repeat: false, skippable: false },
    });
    const p = project([map("a", [controller([
      route("moveRight"),
      { op: "moveControl", target: "player", control: { kind: "stop" } },
      route("moveDown"),
    ])])]);
    const { session, state } = boot(p);
    let out = action(session, state);
    expect(out.playerRoute?.steps).toEqual(["moveDown"]);
    expect(controls(out).player.routeStopped).toBe(false);
    out = fold(session, out, 8);
    expect([out.move.tx, out.move.ty]).toEqual([2, 3]);
  });

  test("player place relocates at the session boundary and sets facing", () => {
    const p = project([map("a", [controller([
      { op: "place", target: "player", x: 7, y: 6, dir: "right" },
    ])])]);
    const { session, state } = boot(p);
    const out = action(session, state);
    expect(out.move).toMatchObject({ tx: 7, ty: 6, px: 112, py: 96, facing: 3, phase: 0, moving: false });
  });
});

describe("KM1 speed, stop, and facing controls", () => {
  test("grade 5 preserves a custom session speed and other grades scale from it", () => {
    const fast = { tile: 16, speed: 16 };
    expect(movementConfigFor(fast, { speed: 5, running: false })).toEqual(fast);
    expect(movementConfigFor(fast, { speed: 4, running: false })).toEqual({ tile: 16, speed: 8 });
    expect(movementConfigFor(fast, { speed: 5, running: true })).toEqual(fast);
  });

  test("speed 6 and run-at-5 both take four reference ticks per tile", () => {
    for (const control of [
      [{ kind: "speed", value: 6 }] as MoveControl[],
      [{ kind: "speed", value: 5 }, { kind: "run", value: true }] as MoveControl[],
    ]) {
      const runner = event("runner", 1, 5, [page("action", [])]);
      const commands: Command[] = [
        ...control.map((value): Command => ({ op: "moveControl", target: { event: "runner" }, control: value })),
        {
          op: "moveRoute",
          target: { event: "runner" },
          route: { steps: ["moveRight"], repeat: false, skippable: false },
        },
      ];
      const p = project([map("a", [controller(commands), runner])]);
      const { session, state } = boot(p);
      let out = action(session, state);
      out = fold(session, out, 3);
      expect(out.chars.chars.runner).toMatchObject({ tx: 1, phase: 3, px: 28 });
      out = stepSession(session, out, { buttons: 0 });
      expect(out.chars.chars.runner).toMatchObject({ tx: 2, phase: 0, px: 32 });
    }
  });

  test("a speed change during a player step is latched until the next tile", () => {
    const timer = event("timer", 8, 7, [page("parallel", [
      { op: "wait", seconds: 2 / 60 },
      { op: "moveControl", target: "player", control: { kind: "speed", value: 6 } },
      { op: "exit" },
    ])]);
    const p = project([map("a", [timer])], { map: "a", x: 2, y: 2, dir: "right" });
    const { session, state } = boot(p);
    let out = state;
    const pixels: number[] = [];
    for (let i = 0; i < 4; i++) {
      out = stepSession(session, out, { buttons: i === 0 ? BTN.RIGHT : 0 });
      pixels.push(out.move.px);
    }
    expect(pixels).toEqual([34, 36, 38, 40]);
    out = fold(session, out, 4);
    expect(out.move).toMatchObject({ tx: 3, px: 48, moving: false });
    out = stepSession(session, out, { buttons: BTN.RIGHT });
    expect(out.move).toMatchObject({ tx: 3, px: 52, phase: 1 });
  });

  test("standalone stop finishes the committed tile, drops the rest, and resumes the waiter", () => {
    const runner = event("runner", 1, 5, [page("action", [])]);
    const stopper = event("stopper", 8, 7, [page("parallel", [
      { op: "wait", seconds: 3 / 60 },
      { op: "moveControl", target: { event: "runner" }, control: { kind: "stop" } },
      { op: "exit" },
    ])]);
    const p = project([map("a", [controller([
      {
        op: "moveRoute",
        target: { event: "runner" },
        wait: true,
        route: { steps: ["moveRight", "moveRight", "moveRight"], repeat: false, skippable: false },
      },
      { op: "switch", id: "waiter-resumed", value: true },
    ]), runner, stopper])]);
    const { session, state } = boot(p);
    const out = fold(session, action(session, state), 30);
    expect(out.chars.chars.runner).toMatchObject({ tx: 2, ty: 5, moving: false, route: null });
    expect(out.sw.switches["waiter-resumed"]).toBe(true);
    expect(controls(out).events.runner?.routeStopped).toBe(true);
  });

  test("stop remains route-only while moveType static explicitly ends wander", () => {
    const wandering = project([map("a", [controller([
      { op: "moveControl", target: "player", control: { kind: "wander" } },
      { op: "moveControl", target: "player", control: { kind: "stop" } },
    ])])]);
    let run = boot(wandering);
    let out = action(run.session, run.state);
    out = stepSession(run.session, out, { buttons: 0 });
    expect(isSessionWorldIdle(out)).toBe(false);
    out = fold(run.session, out, 7);
    expect([out.move.tx, out.move.ty]).not.toEqual([2, 2]);

    const stopped = project([map("a", [controller([
      { op: "moveControl", target: "player", control: { kind: "wander" } },
      { op: "moveControl", target: "player", control: { kind: "stop" } },
      { op: "moveControl", target: "player", control: { kind: "moveType", value: "static" } },
    ])])]);
    run = boot(stopped);
    out = action(run.session, run.state);
    out = stepSession(run.session, out, { buttons: 0 });
    expect(isSessionWorldIdle(out)).toBe(true);
    out = fold(run.session, out, 8);
    expect([out.move.tx, out.move.ty]).toEqual([2, 2]);
  });

  test("a route control stop terminates itself before later steps", () => {
    const runner = event("runner", 1, 5, [page("action", [])]);
    const p = project([map("a", [controller([
      {
        op: "moveRoute",
        target: { event: "runner" },
        wait: true,
        route: {
          steps: ["moveRight", { control: { kind: "stop" } }, "moveRight"],
          repeat: false,
          skippable: false,
        },
      },
      { op: "switch", id: "done", value: true },
    ]), runner])]);
    const { session, state } = boot(p);
    const out = fold(session, action(session, state), 15);
    expect([out.chars.chars.runner!.tx, out.chars.chars.runner!.ty]).toEqual([2, 5]);
    expect(out.sw.switches.done).toBe(true);
  });

  test("directionFix blocks every turn; locked/scripted only block movement turns", () => {
    const fixed = event("fixed", 1, 5, [page("action", [], {
      dir: "down",
      directionFix: true,
      moveRoute: { steps: ["faceRight", "moveRight"], repeat: false, skippable: false },
    })]);
    const scripted = event("scripted", 4, 5, [page("action", [])]);
    const p = project([map("a", [controller([
      {
        op: "moveRoute",
        target: { event: "scripted" },
        route: {
          steps: [
            { control: { kind: "facingMode", value: "scripted" } },
            "moveRight",
            "faceUp",
          ],
          repeat: false,
          skippable: false,
        },
      },
    ]), fixed, scripted])]);
    const { session, state } = boot(p);
    let out = action(session, state);
    out = fold(session, out, 12);
    expect(out.chars.chars.fixed).toMatchObject({ tx: 2, ty: 5, facing: 0 });
    expect(out.chars.chars.scripted).toMatchObject({ tx: 5, ty: 5, facing: 2 });
  });
});

describe("KM1 through and deterministic wander", () => {
  test("through crosses terrain and bodies, ignores a through body, but not map bounds", () => {
    const blocker = event("blocker", 2, 1, [page("action", [], { blocks: true })]);
    const runner = event("runner", 1, 5, [page("action", [])]);
    const body = event("body", 2, 5, [page("action", [], { blocks: true })]);
    const p = project([map("a", [
      event("controller", 1, 2, [page("action", [
        { op: "moveControl", target: "player", control: { kind: "through", value: true } },
        { op: "moveControl", target: { event: "runner" }, control: { kind: "through", value: true } },
        {
          op: "moveRoute",
          target: { event: "runner" },
          wait: false,
          route: { steps: ["moveRight"], repeat: false, skippable: false },
        },
      ])]),
      blocker,
      runner,
      body,
    ], [[1 * 10 + 2, "block"], [5 * 10 + 2, "block"]])], {
      map: "a", x: 1, y: 1, dir: "down",
    });
    const { session, state } = boot(p);
    let out = action(session, state);
    out = fold(session, out, 8, BTN.RIGHT);
    expect([out.move.tx, out.move.ty]).toEqual([2, 1]);
    expect([out.chars.chars.runner!.tx, out.chars.chars.runner!.ty]).toEqual([2, 5]);

    // Direct placement at the left edge lets the same through setting prove
    // that finite map bounds remain absolute.
    out.move = { ...out.move, tx: 0, ty: 1, px: 0, py: 16, phase: 0, moving: false, walking: false };
    out = fold(session, out, 8, BTN.LEFT);
    expect([out.move.tx, out.move.ty]).toEqual([0, 1]);
  });

  test("a through event body does not block the ordinary player", () => {
    const ghost = event("ghost", 3, 2, [page("action", [], { blocks: true })]);
    const p = project([map("a", [controller([
      { op: "moveControl", target: { event: "ghost" }, control: { kind: "through", value: true } },
    ]), ghost])], { map: "a", x: 2, y: 2, dir: "down" });
    const { session, state } = boot(p);
    let out = action(session, state);
    out = fold(session, out, 8, BTN.RIGHT);
    expect([out.move.tx, out.move.ty]).toEqual([3, 2]);
  });

  test("bounded wander has no idle draw, stays inside, and consumes no RNG with no exit", () => {
    const wanderer = event("wanderer", 5, 5, [page("action", [])]);
    const p = project([map("a", [controller([
      {
        op: "moveControl",
        target: { event: "wanderer" },
        control: { kind: "wander", bounds: { x: 5, y: 5, width: 1, height: 1 }, frequency: 5 },
      },
    ]), wanderer])]);
    const { session, state } = boot(p);
    let out = action(session, state);
    const rng = out.sw.rng;
    out = fold(session, out, 240);
    expect(out.chars.chars.wanderer).toMatchObject({ tx: 5, ty: 5, moving: false });
    expect(out.sw.rng).toBe(rng);
  });

  test("frequency uses MV reference-tick cadence while the clock keeps running mid-step", () => {
    expect(([1, 2, 3, 4, 5] as MoveFrequency[]).map(frequencyDelay)).toEqual([120, 90, 60, 30, 0]);
    const wanderer = event("wanderer", 5, 5, [page("action", [])]);
    const p = project([map("a", [controller([
      {
        op: "moveControl",
        target: { event: "wanderer" },
        control: { kind: "wander", bounds: { x: 4, y: 5, width: 3, height: 1 }, frequency: 1 },
      },
    ]), wanderer])]);
    const { session, state } = boot(p);
    let out = fold(session, action(session, state), 8);
    expect(out.chars.chars.wanderer).toMatchObject({ moving: false, thinkIn: 113 });
    const at = [out.chars.chars.wanderer!.tx, out.chars.chars.wanderer!.ty];
    out = fold(session, out, 112);
    expect([out.chars.chars.wanderer!.tx, out.chars.chars.wanderer!.ty]).toEqual(at);
    expect(out.chars.chars.wanderer!.moving).toBe(false);
    out = stepSession(session, out, { buttons: 0 });
    expect(out.chars.chars.wanderer!.moving).toBe(true);
  });

  test("an exact wander interval runs through movement and blocked attempts without extra RNG", () => {
    const wanderer = event("wanderer", 5, 5, [page("action", [])]);
    const p = project([map("a", [controller([{
      op: "moveControl",
      target: { event: "wanderer" },
      control: {
        kind: "wander",
        bounds: { x: 4, y: 5, width: 3, height: 1 },
        intervalTicks: 18,
      },
    }]), wanderer])]);
    const { session, state } = boot(p);
    let out = action(session, state);
    out = stepSession(session, out, { buttons: 0 });
    expect(out.chars.chars.wanderer).toMatchObject({ moving: true, phase: 1, thinkIn: 18 });
    out = fold(session, out, 7);
    expect(out.chars.chars.wanderer).toMatchObject({ moving: false, thinkIn: 11 });
    const at = [out.chars.chars.wanderer!.tx, out.chars.chars.wanderer!.ty];
    out = fold(session, out, 10);
    expect(out.chars.chars.wanderer).toMatchObject({ moving: false, thinkIn: 1 });
    expect([out.chars.chars.wanderer!.tx, out.chars.chars.wanderer!.ty]).toEqual(at);
    out = stepSession(session, out, { buttons: 0 });
    expect(out.chars.chars.wanderer).toMatchObject({ moving: true, phase: 1, thinkIn: 18 });

    const boxed = project([map("a", [controller([{
      op: "moveControl",
      target: { event: "wanderer" },
      control: { kind: "wander", bounds: { x: 5, y: 5, width: 1, height: 1 }, intervalTicks: 3 },
    }]), wanderer])]);
    const run = boot(boxed);
    out = action(run.session, run.state);
    const rng = out.sw.rng;
    out = fold(run.session, out, 10);
    expect(out.chars.chars.wanderer).toMatchObject({ tx: 5, ty: 5, moving: false, thinkIn: 3 });
    expect(out.sw.rng).toBe(rng);
  });

  test("an adjacent player facing the NPC suppresses only the due wander attempt", () => {
    const wanderer = event("wanderer", 5, 5, [page("action", [{
      op: "moveControl",
      target: "this",
      control: {
        kind: "wander",
        bounds: { x: 4, y: 5, width: 3, height: 1 },
        intervalTicks: 3,
      },
    }])]);
    const p = project([map("a", [wanderer])], { map: "a", x: 5, y: 4, dir: "down" });
    const { session, state } = boot(p);
    let out = action(session, state);
    const rng = out.sw.rng;
    out = stepSession(session, out, { buttons: 0 });
    expect(out.chars.chars.wanderer).toMatchObject({ moving: false, thinkIn: 3 });
    out = fold(session, out, 3);
    expect(out.chars.chars.wanderer).toMatchObject({ moving: false, thinkIn: 3 });
    expect(out.sw.rng).toBe(rng);

    out = { ...out, move: { ...out.move, facing: 2 } };
    out = fold(session, out, 3);
    expect(out.chars.chars.wanderer).toMatchObject({ moving: true, phase: 1, thinkIn: 3 });
    expect(out.sw.rng).not.toBe(rng);
  });

  test("runtime wander is byte-deterministic at 60/30/20/4 Hz", () => {
    const wanderer = event("wanderer", 5, 4, [page("action", [])]);
    const p = project([map("a", [controller([
      {
        op: "moveControl",
        target: { event: "wanderer" },
        control: { kind: "wander", bounds: { x: 3, y: 3, width: 5, height: 3 }, frequency: 4 },
      },
    ]), wanderer])]);
    const projections = ([60, 30, 20, 4] as const).map((hz) => {
      const { session, state } = boot(p, hz);
      let out = action(session, state);
      out = foldReferenceTicks(session, out, 240 - session.ticksPerFrame);
      return motionProjection(out);
    });
    for (const value of projections.slice(1)) expect(value).toEqual(projections[0]);
    const ch = (projections[0] as any).chars.chars.wanderer;
    expect(ch.tx).toBeGreaterThanOrEqual(3);
    expect(ch.tx).toBeLessThan(8);
    expect(ch.ty).toBeGreaterThanOrEqual(3);
    expect(ch.ty).toBeLessThan(6);
  });
});

describe("KM1 lifecycle, holds, save, and rewind", () => {
  test("event page change and map transfer reset their documented scopes", () => {
    const flipping = event("flipping", 2, 3, [
      page("action", [
        { op: "moveControl", target: "this", control: { kind: "speed", value: 2 } },
        { op: "switch", id: "page-two", value: true },
      ]),
      page("action", [], { condition: { switch: "page-two" } }),
    ]);
    const p = project([
      map("a", [flipping]),
      map("b", []),
    ]);
    const { session, state } = boot(p);
    let out = action(session, state);
    expect(controls(out).events.flipping?.pageIndex).toBe(0);
    out = stepSession(session, out, { buttons: 0 });
    expect(controls(out).events.flipping).toBeUndefined();

    const transferProject = project([
      map("a", [controller([
        { op: "moveControl", target: "player", control: { kind: "speed", value: 2 } },
        { op: "transfer", map: "b", x: 1, y: 1 },
      ])]),
      map("b", []),
    ]);
    const transfer = boot(transferProject);
    out = action(transfer.session, transfer.state);
    expect(out.mapId).toBe("b");
    expect(out.interp.moveControls).toBeUndefined();
  });

  test("player wander blocks worldIdle; NPC wander does not", () => {
    const npc = event("npc", 6, 5, [page("action", [])]);
    const playerProject = project([map("a", [controller([
      { op: "moveControl", target: "player", control: { kind: "wander" } },
    ]), npc])]);
    let run = boot(playerProject);
    let out = action(run.session, run.state);
    expect(isSessionWorldIdle(out)).toBe(false);

    const npcProject = project([map("a", [controller([
      { op: "moveControl", target: { event: "npc" }, control: { kind: "wander", intervalTicks: 7 } },
    ]), npc])]);
    run = boot(npcProject);
    out = action(run.session, run.state);
    expect(isSessionWorldIdle(out)).toBe(true);
  });

  test("input lock freezes player wander while NPC wander continues", () => {
    const npc = event("npc", 6, 5, [page("action", [])]);
    const p = project([map("a", [controller([
      { op: "moveControl", target: "player", control: { kind: "wander", bounds: { x: 1, y: 1, width: 4, height: 4 } } },
      { op: "moveControl", target: { event: "npc" }, control: { kind: "wander", bounds: { x: 5, y: 4, width: 4, height: 3 } } },
      { op: "lockInput" },
    ]), npc])]);
    const run = boot(p);
    const out = fold(run.session, action(run.session, run.state), 40);
    expect(out.move).toMatchObject({ tx: 2, ty: 2, moving: false });
    expect([out.chars.chars.npc!.tx, out.chars.chars.npc!.ty]).not.toEqual([6, 5]);
  });

  test("a non-blocking parallel dialog pauses runtime player and NPC wander", () => {
    const npc = event("npc", 6, 5, [page("action", [])]);
    const talker = event("talker", 0, 0, [page("parallel", [
      { op: "text", lines: ["hold"] },
    ], { condition: { switch: "open-dialog" } })]);
    const p = project([map("a", [controller([
      { op: "moveControl", target: "player", control: { kind: "wander" } },
      { op: "moveControl", target: { event: "npc" }, control: { kind: "wander", intervalTicks: 7 } },
      { op: "switch", id: "open-dialog", value: true },
    ]), npc, talker])]);
    const run = boot(p);
    let out = action(run.session, run.state);
    out = stepSession(run.session, out, { buttons: 0 });
    expect(out.interp.modal?.kind).toBe("text");
    expect(out.interp.main).toBeNull();
    const heldPlayer = structuredClone(out.move);
    out = fold(run.session, out, 20);
    // Player autonomous motion freezes immediately. An NPC finishes the
    // tile it already committed, then makes no new random decision.
    expect(out.move).toEqual(heldPlayer);
    expect(out.chars.chars.npc!.moving).toBe(false);
    const heldNpc = structuredClone(out.chars.chars.npc);
    const heldRng = out.sw.rng;
    out = fold(run.session, out, 20);
    expect(out.move).toEqual(heldPlayer);
    expect(out.chars.chars.npc).toMatchObject({
      tx: heldNpc!.tx,
      ty: heldNpc!.ty,
      moving: false,
    });
    expect(out.chars.chars.npc!.thinkIn).toBeGreaterThan(0);
    expect(out.chars.chars.npc!.thinkIn).toBeLessThanOrEqual(7);
    expect(out.sw.rng).toBe(heldRng);
  });

  test("controls survive save/load, malformed controls are rejected, and old bytes stay sparse", () => {
    const npc = event("npc", 6, 5, [page("action", [])]);
    const p = project([map("a", [controller([
      { op: "moveControl", target: "player", control: { kind: "speed", value: 4 } },
      { op: "moveControl", target: "player", control: { kind: "wander", bounds: { x: 1, y: 1, width: 4, height: 4 }, frequency: 3 } },
      { op: "moveControl", target: { event: "npc" }, control: { kind: "wander", intervalTicks: 17 } },
    ]), npc])]);
    const run = boot(p);
    // Let the first deterministic wander step land so the snapshot is taken
    // at the next legal tile boundary.
    const controlled = fold(run.session, action(run.session, run.state), 16);
    const encoded = encodeEnvelope(createSessionSnapshot(run.session, controlled, 0));
    const decoded = decodeEnvelopeText(encoded);
    const restored = restoreSessionSnapshot(run.session, decoded);
    expect(restored.interp.moveControls).toEqual(controlled.interp.moveControls);

    const a = fold(run.session, controlled, 120);
    const b = fold(run.session, restored, 120);
    expect(motionProjection(b)).toEqual(motionProjection(a));

    const malformed = createSessionSnapshot(run.session, controlled, 0) as any;
    malformed.interp.moveControls.player.speed = 99;
    expect(validateSnapshot(malformed)).toBe(
      "state.interp.moveControls.player.speed: movement speed grade 1..6 required",
    );

    const valid = createSessionSnapshot(run.session, controlled, 0) as any;
    const invalidOverrides: Array<[
      string,
      (snapshot: any) => void,
      string,
    ]> = [
      ["container", (snapshot) => { snapshot.interp.moveControls = []; },
        "state.interp.moveControls: movement control state required"],
      ["player", (snapshot) => { snapshot.interp.moveControls.player = null; },
        "state.interp.moveControls.player: movement override object required"],
      ["events", (snapshot) => { snapshot.interp.moveControls.events = []; },
        "state.interp.moveControls.events: record required"],
      ["empty event id", (snapshot) => { snapshot.interp.moveControls.events = { "": { pageIndex: 0 } }; },
        "state.interp.moveControls.events: event ids must be non-empty"],
      ["page index", (snapshot) => { snapshot.interp.moveControls.events = { npc: {} }; },
        "state.interp.moveControls.events.npc.pageIndex: non-negative integer required"],
      ["unknown field", (snapshot) => { snapshot.interp.moveControls.player.extra = true; },
        "state.interp.moveControls.player.extra: unknown movement override field"],
      ["stored move type", (snapshot) => { snapshot.interp.moveControls.player.moveType = "page"; },
        "state.interp.moveControls.player.moveType: static|random|approach required"],
      ["bounds", (snapshot) => { snapshot.interp.moveControls.player.bounds = { x: 0, y: 0, width: 0, height: 1 }; },
        "state.interp.moveControls.player.bounds: non-empty {x,y,width,height} tile rectangle required"],
      ["frequency", (snapshot) => { snapshot.interp.moveControls.player.frequency = 0; },
        "state.interp.moveControls.player.frequency: movement frequency grade 1..5 required"],
      ["wander interval", (snapshot) => { snapshot.interp.moveControls.events.npc.wanderIntervalTicks = 0; },
        "state.interp.moveControls.events.npc.wanderIntervalTicks: positive reference-tick interval required"],
      ["running", (snapshot) => { snapshot.interp.moveControls.player.running = "yes"; },
        "state.interp.moveControls.player.running: boolean required"],
      ["directionFix", (snapshot) => { snapshot.interp.moveControls.player.directionFix = "yes"; },
        "state.interp.moveControls.player.directionFix: boolean required"],
      ["through", (snapshot) => { snapshot.interp.moveControls.player.through = "yes"; },
        "state.interp.moveControls.player.through: boolean required"],
      ["routeStopped", (snapshot) => { snapshot.interp.moveControls.player.routeStopped = "yes"; },
        "state.interp.moveControls.player.routeStopped: boolean required"],
      ["facing mode", (snapshot) => { snapshot.interp.moveControls.player.facingMode = "free"; },
        "state.interp.moveControls.player.facingMode: followMovement|locked|scripted required"],
      ["cooldown", (snapshot) => { snapshot.interp.moveControls.player.cooldown = -1; },
        "state.interp.moveControls.player.cooldown: non-negative integer required"],
      ["routeSpeed", (snapshot) => { snapshot.interp.moveControls.player.routeSpeed = 9; },
        "state.interp.moveControls.player.routeSpeed: movement speed grade 1..6 required"],
    ];
    for (const [label, mutate, expected] of invalidOverrides) {
      const bad = structuredClone(valid);
      mutate(bad);
      expect(validateSnapshot(bad), label).toBe(expected);
    }

    const legacy = startSession(p, run.session);
    expect(legacy.interp.moveControls).toBeUndefined();
    expect(JSON.stringify(legacy.interp)).not.toContain("moveControls");
  });

  test("rewind restores the same controlled random trajectory with and without keyframes", () => {
    const driver = event("driver", 0, 0, [
      page("autorun", [
        {
          op: "moveControl",
          target: "player",
          control: { kind: "wander", bounds: { x: 1, y: 1, width: 6, height: 5 }, frequency: 4 },
        },
        { op: "selfSwitch", key: "A", value: true },
      ]),
      page("parallel", [], { condition: { selfSwitch: "A" } }),
    ]);
    const p = project([map("a", [driver])], { map: "a", x: 3, y: 3, dir: "down" });
    const tape = new Array<number>(600).fill(0);
    const options = {
      hz: 60,
      tapeHz: 60,
      idleFrames: 60_000,
      endHoldFrames: 60_000,
      rewindSeconds: 0.5,
      keyframeIntervalFrames: 17,
    };
    const keyed = new AttractController(p, tape, options);
    const fromZero = new AttractController(p, tape, { ...options, keyframeMaxBytes: 0 });
    keyed.startAttract();
    fromZero.startAttract();
    for (let i = 0; i < 140; i++) {
      keyed.step(0);
      fromZero.step(0);
    }
    keyed.step(BTN.L);
    fromZero.step(BTN.L);
    expect(keyed.state).toEqual(fromZero.state);
    expect(keyed.state.interp.moveControls?.player.moveType).toBe("random");
    expect(keyed.keyframeStats().lastRefoldStart).toBeGreaterThan(0);
  });

  test("creating a move-control state is prototype-safe", () => {
    const state = createMoveControlState();
    expect(Object.getPrototypeOf(state.events)).toBeNull();
  });
});

describe("KM1 route-scoped speed (routeSpeed)", () => {
  test("all authored exact rates land on the mathematical crossing tick from varied world positions", () => {
    const cases = [
      { rate: 0.5, x: 37, y: 20, step: "moveRight" as const, dx: 1, dy: 0 },
      { rate: 1, x: 37, y: 20, step: "moveLeft" as const, dx: -1, dy: 0 },
      { rate: 1.5, x: 20, y: 37, step: "moveDown" as const, dx: 0, dy: 1 },
      { rate: 3, x: 20, y: 37, step: "moveUp" as const, dx: 0, dy: -1 },
      { rate: 3.75, x: 37, y: 21, step: "moveRight" as const, dx: 1, dy: 0 },
      { rate: 5, x: 38, y: 21, step: "moveLeft" as const, dx: -1, dy: 0 },
      { rate: 7, x: 21, y: 37, step: "moveDown" as const, dx: 0, dy: 1 },
      { rate: 8, x: 21, y: 38, step: "moveUp" as const, dx: 0, dy: -1 },
      { rate: 9, x: 37, y: 22, step: "moveRight" as const, dx: 1, dy: 0 },
      { rate: 10, x: 37, y: 22, step: "moveLeft" as const, dx: -1, dy: 0 },
    ];

    for (const c of cases) {
      const runner = event("runner", c.x, c.y, [page("action", [])]);
      const p = project([map("a", [controller([
        {
          op: "moveControl",
          target: { event: "runner" },
          control: { kind: "routeSpeed", value: 5, tilesPerSecond: c.rate },
        },
        {
          op: "moveRoute",
          target: { event: "runner" },
          wait: false,
          route: { steps: [c.step], repeat: false, skippable: false },
        },
      ]), runner], undefined, 50, 50)]);
      const run = boot(p);
      let out = action(run.session, run.state);
      const frames = Math.ceil(60 / c.rate);
      for (let tick = 1; tick < frames; tick++) {
        out = stepSession(run.session, out, { buttons: 0 });
        const ch = out.chars.chars.runner!;
        expect(ch.moving, `${c.rate} tps landed before tick ${frames}`).toBeTrue();
        expect(ch.phase, `${c.rate} tps phase ${tick}`).toBe(tick);
        expect(ch.px).toBeCloseTo(c.x * 16 + c.dx * tick * 16 * c.rate / 60, 10);
        expect(ch.py).toBeCloseTo(c.y * 16 + c.dy * tick * 16 * c.rate / 60, 10);
        expect(ch.stepTilesPerSecond).toBe(c.rate);
      }
      out = stepSession(run.session, out, { buttons: 0 });
      expect(out.chars.chars.runner, `${c.rate} tps crossing tick`).toMatchObject({
        tx: c.x + c.dx,
        ty: c.y + c.dy,
        px: (c.x + c.dx) * 16,
        py: (c.y + c.dy) * 16,
        phase: 0,
        moving: false,
      });
      expect(out.chars.chars.runner?.stepTilesPerSecond).toBeUndefined();
    }
  });

  test("a 10 tps exact step keeps its latch through a phase-5 save and lands on tick 6", () => {
    const runner = event("runner", 37, 22, [page("action", [])]);
    const p = project([map("a", [controller([
      {
        op: "moveControl",
        target: { event: "runner" },
        control: { kind: "routeSpeed", value: 6, tilesPerSecond: 10 },
      },
      {
        op: "moveRoute",
        target: { event: "runner" },
        wait: false,
        route: { steps: ["moveRight"], repeat: false, skippable: false },
      },
    ]), runner], undefined, 50, 50)]);
    const run = boot(p);
    const phaseFive = fold(run.session, action(run.session, run.state), 5);
    expect(phaseFive.chars.chars.runner).toMatchObject({
      tx: 37,
      phase: 5,
      moving: true,
      stepTilesPerSecond: 10,
    });
    const snapshot = createSessionSnapshot(run.session, phaseFive, 0);
    expect(validateSnapshot(snapshot)).toBeNull();
    const restored = restoreSessionSnapshot(run.session, decodeEnvelopeText(encodeEnvelope(snapshot)));
    expect(restored.chars.chars.runner?.stepTilesPerSecond).toBe(10);

    const legacy = structuredClone(snapshot) as any;
    delete legacy.mapRuntime.chars.chars.runner.stepTilesPerSecond;
    expect(validateSnapshot(legacy)).toBeNull();
    const legacyRestored = restoreSessionSnapshot(
      run.session,
      decodeEnvelopeText(encodeEnvelope(legacy)),
    );

    const malformedRate = structuredClone(snapshot) as any;
    malformedRate.mapRuntime.chars.chars.runner.stepTilesPerSecond = 0;
    expect(validateSnapshot(malformedRate)).toBe(
      "state.mapRuntime.chars.chars.runner.stepTilesPerSecond: exact speed in (0,20] tiles/second required",
    );
    const malformedPosition = structuredClone(snapshot) as any;
    malformedPosition.mapRuntime.chars.chars.runner.px -= 0.25;
    expect(validateSnapshot(malformedPosition)).toBe(
      "state.mapRuntime.chars.chars.runner: pixel offset must match the committed exact speed (character)",
    );

    const direct = fold(run.session, phaseFive, 1);
    const replay = fold(run.session, restored, 1);
    const legacyReplay = fold(run.session, legacyRestored, 1);
    expect(motionProjection(replay)).toEqual(motionProjection(direct));
    expect(motionProjection(legacyReplay)).toEqual(motionProjection(direct));
    expect(direct.chars.chars.runner).toMatchObject({
      tx: 38,
      px: 608,
      phase: 0,
      moving: false,
    });
    expect(direct.chars.chars.runner?.stepTilesPerSecond).toBeUndefined();
  });

  test("a pending 1 tps char_speed is consumed by the first runtime-wander tile", () => {
    const runner = event("runner", 37, 20, [page("action", [])]);
    const driver = event("driver", 0, 0, [
      page("autorun", [
        {
          op: "moveControl",
          target: { event: "runner" },
          control: { kind: "routeSpeed", value: 2, tilesPerSecond: 1 },
        },
        {
          op: "moveControl",
          target: { event: "runner" },
          control: {
            kind: "wander",
            bounds: { x: 38, y: 20, width: 1, height: 1 },
            intervalTicks: 1,
          },
        },
        { op: "selfSwitch", key: "A", value: true },
      ]),
      page("parallel", [], { condition: { selfSwitch: "A" } }),
    ]);
    const p = project([map("a", [driver, runner], undefined, 50, 50)]);
    const run = boot(p);
    let out = fold(run.session, run.state, 1); // publish the two controls
    expect(controls(out).events.runner).toMatchObject({
      routeSpeed: 2,
      routeTilesPerSecond: 1,
      moveType: "random",
    });

    out = fold(run.session, out, 1); // the only bounded exit commits
    expect(out.chars.chars.runner).toMatchObject({
      tx: 37,
      phase: 1,
      moving: true,
      stepTilesPerSecond: 1,
    });
    expect(out.chars.chars.runner?.px).toBeCloseTo(37 * 16 + 16 / 60, 12);
    expect(controls(out).events.runner?.routeSpeed).toBeUndefined();
    expect(controls(out).events.runner?.routeTilesPerSecond).toBeUndefined();

    const phaseThirty = fold(run.session, out, 29);
    const snapshot = createSessionSnapshot(run.session, phaseThirty, 0);
    expect(validateSnapshot(snapshot)).toBeNull();
    const restored = restoreSessionSnapshot(run.session, decodeEnvelopeText(encodeEnvelope(snapshot)));
    const direct = fold(run.session, phaseThirty, 30);
    const replay = fold(run.session, restored, 30);
    expect(motionProjection(replay)).toEqual(motionProjection(direct));
    expect(direct.chars.chars.runner).toMatchObject({
      tx: 38,
      px: 608,
      phase: 0,
      moving: false,
    });
    expect(direct.chars.chars.runner?.stepTilesPerSecond).toBeUndefined();
  });

  test("an exact route speed keeps the authored per-tick velocity and snaps only at the waypoint", () => {
    const exact = movementConfigForTilesPerSecond({ tile: 16, speed: 2 }, 7);
    expect(exact.speed).toBeCloseTo(16 * 7 / 60, 12);

    const runner = event("runner", 1, 5, [page("action", [], { moveSpeed: 4 })]);
    const p = project([map("a", [controller([
      {
        op: "moveControl",
        target: { event: "runner" },
        control: { kind: "routeSpeed", value: 5, tilesPerSecond: 7 },
      },
      {
        op: "moveRoute",
        target: { event: "runner" },
        wait: false,
        route: { steps: ["moveRight", "moveRight"], repeat: false, skippable: false },
      },
    ]), runner])]);
    const run = boot(p);
    let out = action(run.session, run.state);
    expect(out.chars.chars.runner?.route).toMatchObject({ speed: 5, tilesPerSecond: 7 });
    expect(out.interp.moveControls?.events.runner?.routeTilesPerSecond).toBeUndefined();

    const positions: number[] = [];
    for (let tick = 1; tick <= 9; tick++) {
      out = stepSession(run.session, out, { buttons: 0 });
      positions.push(out.chars.chars.runner!.px);
    }
    for (let tick = 1; tick < 9; tick++) {
      expect(positions[tick - 1]!).toBeCloseTo(16 + tick * 16 * 7 / 60, 10);
    }
    expect(positions[8]).toBe(32);
    expect(out.chars.chars.runner).toMatchObject({ tx: 2, phase: 0, moving: false });
    out = fold(run.session, out, 9);
    expect(out.chars.chars.runner).toMatchObject({ tx: 3, px: 48, phase: 0, moving: false });
    expect(out.chars.chars.runner?.route).toBeNull();
  });

  test("exact route speed is identical at 60/30/20 Hz and survives a mid-step save", () => {
    const runner = event("runner", 1, 5, [page("action", [], { moveSpeed: 4 })]);
    const p = project([map("a", [controller([
      {
        op: "moveControl",
        target: { event: "runner" },
        control: { kind: "routeSpeed", value: 5, tilesPerSecond: 7 },
      },
      {
        op: "moveRoute",
        target: { event: "runner" },
        wait: false,
        route: { steps: ["moveRight", "moveRight", "moveRight"], repeat: false, skippable: false },
      },
    ]), runner])]);
    const projections = ([60, 30, 20] as const).map((hz) => {
      const run = boot(p, hz);
      const started = action(run.session, run.state);
      const mid = foldReferenceTicks(run.session, started, 12 - run.session.ticksPerFrame);
      return motionProjection(mid);
    });
    expect(projections[1]).toEqual(projections[0]);
    expect(projections[2]).toEqual(projections[0]);

    const run = boot(p);
    const mid = fold(run.session, action(run.session, run.state), 4);
    expect(mid.chars.chars.runner).toMatchObject({ phase: 4, moving: true });
    expect(mid.chars.chars.runner!.px).toBeCloseTo(16 + 4 * 16 * 7 / 60, 10);
    const snapshot = createSessionSnapshot(run.session, mid, 0);
    expect(validateSnapshot(snapshot)).toBeNull();
    const invalidRoute = structuredClone(snapshot) as any;
    invalidRoute.mapRuntime.chars.chars.runner.route.tilesPerSecond = 21;
    expect(validateSnapshot(invalidRoute)).toBe(
      "state.mapRuntime.chars.chars.runner.route.tilesPerSecond: exact speed in (0,20] tiles/second required",
    );
    const invalidStep = structuredClone(snapshot) as any;
    invalidStep.mapRuntime.chars.chars.runner.route.steps[0] = {
      control: { kind: "routeSpeed", value: 5, tilesPerSecond: 0 },
    };
    expect(validateSnapshot(invalidStep)).toBe(
      "state.mapRuntime.chars.chars.runner.route.steps[0].control.tilesPerSecond: exact speed in (0,20] tiles/second required",
    );
    const restored = restoreSessionSnapshot(run.session, decodeEnvelopeText(encodeEnvelope(snapshot)));
    expect(restored.chars.chars.runner?.route?.tilesPerSecond).toBe(7);
    expect(motionProjection(fold(run.session, restored, 30)))
      .toEqual(motionProjection(fold(run.session, mid, 30)));
  });

  test("exact player route speed takes precedence over the compatibility grade and run flag", () => {
    const p = project([map("a", [event("driver", 3, 2, [page("action", [
      { op: "moveControl", target: "player", control: { kind: "run", value: true } },
      {
        op: "moveControl",
        target: "player",
        control: { kind: "routeSpeed", value: 2, tilesPerSecond: 7 },
      },
      {
        op: "moveRoute",
        target: "player",
        route: { steps: ["moveRight"], repeat: false, skippable: false },
      },
    ])])])], { map: "a", x: 2, y: 2, dir: "right" });
    const run = boot(p);
    let out = action(run.session, run.state);
    expect(out.playerRoute).toMatchObject({ speed: 2, tilesPerSecond: 7 });
    out = stepSession(run.session, out, { buttons: 0 });
    expect(out.move.px).toBeCloseTo(32 + 16 * 7 / 60, 10);
    expect(out.playerRoute?.phase).toBe(1);
    out = fold(run.session, out, 8);
    expect(out.move).toMatchObject({ tx: 3, px: 48, moving: false });
    expect(out.playerRoute).toBeNull();
    // The route-scoped exact value is gone; ordinary running resumes grade behavior.
    out = stepSession(run.session, out, { buttons: BTN.RIGHT });
    expect(out.move.px).toBe(52);
  });

  test("a pending routeSpeed latches onto the next forced route and is gone when it ends", () => {
    const runner = event("runner", 1, 5, [page("action", [], { moveSpeed: 4 })]);
    const driver = event("driver", 2, 3, [
      page("action", [
        { op: "moveControl", target: { event: "runner" }, control: { kind: "routeSpeed", value: 6 } },
        {
          op: "moveRoute",
          target: { event: "runner" },
          route: { steps: ["moveRight", "moveRight", "moveRight"], repeat: false, skippable: false },
        },
        { op: "selfSwitch", key: "A", value: true },
      ]),
      page("action", [
        {
          op: "moveRoute",
          target: { event: "runner" },
          route: { steps: ["moveRight"], repeat: false, skippable: false },
        },
      ], { condition: { selfSwitch: "A" } }),
    ]);
    const p = project([map("a", [driver, runner])]);
    const { session, state } = boot(p);
    let out = action(session, state);
    // The pending grade is consumed at install; nothing stays behind.
    expect(out.interp.moveControls?.events.runner?.routeSpeed).toBeUndefined();
    expect(out.chars.chars.runner?.route?.speed).toBe(6);
    // Grade 6 takes four reference ticks per tile (page speed 4 would take 16).
    out = fold(session, out, 3);
    expect(out.chars.chars.runner).toMatchObject({ tx: 1, phase: 3, px: 28 });
    out = fold(session, out, 9); // 3 tiles at 4 ticks each, route ends
    expect(out.chars.chars.runner).toMatchObject({ tx: 4, phase: 0, px: 64 });
    expect(out.chars.chars.runner?.route).toBeNull();
    expect(out.interp.moveControls?.events.runner?.routeSpeed).toBeUndefined();
    // A later route without routeSpeed uses the page speed again (grade 4).
    out = action(session, out);
    out = fold(session, out, 15);
    expect(out.chars.chars.runner).toMatchObject({ tx: 4, phase: 15, px: 79 });
    out = stepSession(session, out, { buttons: 0 });
    expect(out.chars.chars.runner).toMatchObject({ tx: 5, phase: 0, px: 80 });
  });

  test("a routeSpeed set while a route runs latches onto that route only", () => {
    const runner = event("runner", 1, 5, [page("action", [], { moveSpeed: 4 })]);
    const booster = event("booster", 8, 7, [page("parallel", [
      { op: "wait", seconds: 20 / 60 },
      { op: "moveControl", target: { event: "runner" }, control: { kind: "routeSpeed", value: 6 } },
      { op: "exit" },
    ])]);
    const p = project([map("a", [controller([
      {
        op: "moveRoute",
        target: { event: "runner" },
        route: { steps: ["moveRight", "moveRight", "moveRight", "moveRight"], repeat: false, skippable: false },
      },
    ]), runner, booster])]);
    const { session, state } = boot(p);
    let out = action(session, state);
    // Tile 1 runs at page speed 4 (16 ticks); the boost lands mid tile 2 and
    // latches, so tile 2 finishes at its own pace and tiles 3-4 take 4 ticks.
    out = fold(session, out, 31);
    expect(out.chars.chars.runner).toMatchObject({ tx: 2, phase: 15, px: 47 });
    out = stepSession(session, out, { buttons: 0 });
    expect(out.chars.chars.runner).toMatchObject({ tx: 3, phase: 0, px: 48 });
    expect(out.chars.chars.runner?.route?.speed).toBe(6);
    expect(out.interp.moveControls?.events.runner?.routeSpeed).toBeUndefined();
    out = fold(session, out, 8); // two tiles at grade 6
    expect(out.chars.chars.runner).toMatchObject({ tx: 5, phase: 0, px: 80 });
    expect(out.chars.chars.runner?.route).toBeNull();
  });

  test("a route-step routeSpeed scopes the grade to its own route", () => {
    const runner = event("runner", 1, 5, [page("action", [], { moveSpeed: 4 })]);
    const commands: Command[] = [
      {
        op: "moveRoute",
        target: { event: "runner" },
        route: {
          steps: [
            { control: { kind: "routeSpeed", value: 6 } },
            "moveRight",
            "moveRight",
          ],
          repeat: false,
          skippable: false,
        },
      },
    ];
    const p = project([map("a", [controller(commands), runner])]);
    const { session, state } = boot(p);
    let out = action(session, state);
    // The control step is instant; tile 1 already runs at grade 6.
    out = fold(session, out, 4);
    expect(out.chars.chars.runner).toMatchObject({ tx: 1, phase: 3, px: 28 });
    out = fold(session, out, 5);
    expect(out.chars.chars.runner).toMatchObject({ tx: 3, phase: 0, px: 48 });
    expect(out.chars.chars.runner?.route).toBeNull();
    // The persistent override was never touched.
    expect(out.interp.moveControls?.events.runner?.routeSpeed).toBeUndefined();
  });

  test("routeSpeed on the player scopes to the player's forced route", () => {
    const p = project([map("a", [event("driver", 3, 2, [page("action", [
      { op: "moveControl", target: "player", control: { kind: "routeSpeed", value: 6 } },
      {
        op: "moveRoute",
        target: "player",
        route: { steps: ["moveRight", "moveRight"], repeat: false, skippable: false },
      },
    ])])])], { map: "a", x: 2, y: 2, dir: "right" });
    const { session, state } = boot(p);
    let out = action(session, state);
    expect(out.playerRoute?.speed).toBe(6);
    expect(out.interp.moveControls?.player.routeSpeed).toBeUndefined();
    out = fold(session, out, 3);
    expect(out.move).toMatchObject({ tx: 2, px: 44, moving: true });
    expect(out.playerRoute?.phase).toBe(3);
    out = fold(session, out, 4); // two tiles at grade 6, route ends
    expect(out.move).toMatchObject({ tx: 4, px: 64, moving: false });
    expect(out.playerRoute).toBeNull();
    // Autonomous movement after the route uses the resolved speed (grade 5).
    out = stepSession(session, out, { buttons: BTN.RIGHT });
    expect(out.move).toMatchObject({ phase: 1, px: 66 });
  });

  test("routeSpeed on the player also scopes to pathTo steps", () => {
    const p = project([map("a", [event("driver", 3, 2, [page("action", [
      { op: "moveControl", target: "player", control: { kind: "routeSpeed", value: 6 } },
      {
        op: "moveRoute",
        target: "player",
        route: {
          steps: [{ pathTo: { x: 5, y: 2 } }],
          repeat: false,
          skippable: false,
        },
      },
    ])])])], { map: "a", x: 2, y: 2, dir: "right" });
    const { session, state } = boot(p);
    let out = action(session, state);
    expect(out.playerRoute?.speed).toBe(6);
    expect(out.interp.moveControls?.player.routeSpeed).toBeUndefined();
    // The first route tick builds the plan, finishes the BFS (80 cells <
    // 250/tick) and commits the first pixel at the latched grade: grade 6
    // is 4 px/tick, not the player's resolved grade 5 (2 px/tick).
    out = fold(session, out, 1);
    expect(out.move).toMatchObject({ tx: 2, px: 36, moving: true });
    expect(out.playerRoute?.phase).toBe(1);
    // Three movement beats at grade 6 land 12 px into the tile.
    out = fold(session, out, 2);
    expect(out.move).toMatchObject({ tx: 2, px: 44, moving: true });
    expect(out.playerRoute?.phase).toBe(3);
    // Three tiles at grade 6: the route runs to (5, 2) and ends.
    out = fold(session, out, 7);
    expect(out.move).toMatchObject({ tx: 5, px: 80, moving: false });
    expect(out.playerRoute).toBeNull();
  });

  test("routeSpeed on the player also scopes to approach steps", () => {
    const npc = event("npc", 5, 2, [page("action", [], { moveType: "static" })]);
    const p = project([map("a", [event("driver", 3, 2, [page("action", [
      { op: "moveControl", target: "player", control: { kind: "routeSpeed", value: 6 } },
      {
        op: "moveRoute",
        target: "player",
        route: {
          steps: [{ approach: { target: { event: "npc" } } }],
          repeat: false,
          skippable: false,
        },
      },
    ])]), npc])], { map: "a", x: 2, y: 2, dir: "right" });
    const { session, state } = boot(p);
    let out = action(session, state);
    expect(out.playerRoute?.speed).toBe(6);
    out = fold(session, out, 1); // plan + search + first pixel at grade 6
    expect(out.move).toMatchObject({ tx: 2, px: 36, moving: true });
    // Two tiles to the stand tile (4, 2), then face the target and finish.
    out = fold(session, out, 6);
    expect(out.move).toMatchObject({ tx: 4, px: 64, moving: false, facing: 3 });
    expect(out.playerRoute).toBeNull();
  });

  test("player routeSpeed pathTo routes are byte-deterministic at 60/30/20/4 Hz", () => {
    // A 20x20 map keeps the BFS multi-tick and the route long enough that a
    // 30-reference-tick checkpoint lands mid-route at every hz.
    const big = map("a", [event("driver", 3, 2, [page("action", [
      { op: "moveControl", target: "player", control: { kind: "routeSpeed", value: 6 } },
      {
        op: "moveRoute",
        target: "player",
        route: {
          steps: [{ pathTo: { x: 19, y: 19 } }],
          repeat: false,
          skippable: false,
        },
      },
    ])])], undefined, 20, 20);
    const p = project([big], { map: "a", x: 2, y: 2, dir: "right" });
    const projections = ([60, 30, 20, 4] as const).map((hz) => {
      const { session, state } = boot(p, hz);
      let out = action(session, state);
      const mid = foldReferenceTicks(session, out, 30 - session.ticksPerFrame);
      out = foldReferenceTicks(session, mid, 240 - 30);
      return { mid, midProj: motionProjection(mid), endProj: motionProjection(out) };
    });
    for (const value of projections.slice(1)) {
      expect(value.midProj).toEqual(projections[0].midProj);
      expect(value.endProj).toEqual(projections[0].endProj);
    }
    expect(projections[0].mid.playerRoute?.speed).toBe(6);
    expect(projections[0].mid.playerRoute).not.toBeNull();
    const end = (projections[0].endProj as any).move;
    expect(end).toMatchObject({ tx: 19, ty: 19, px: 304, py: 304, moving: false });
  });

  test("a latched routeSpeed on a player pathTo route survives save/load and resumes identically", () => {
    // 400 cells > 250/tick, so the BFS stays in flight after its first tick
    // and the plan (search included) is live while the player rests at a
    // manual-save boundary (route phase 0). A parallel page installs the
    // route so the interpreter's main fiber never parks.
    const big = map("a", [event("driver", 0, 0, [page("parallel", [
      { op: "wait", seconds: 2 / 60 },
      { op: "moveControl", target: "player", control: { kind: "routeSpeed", value: 6 } },
      {
        op: "moveRoute",
        target: "player",
        route: {
          steps: [{ pathTo: { x: 19, y: 19 } }],
          repeat: false,
          skippable: false,
        },
      },
      { op: "exit" },
    ])])], undefined, 20, 20);
    const p = project([big], { map: "a", x: 2, y: 2, dir: "right" });
    const run = boot(p);
    const controlled = fold(run.session, run.state, 4); // search in flight, phase 0
    expect(controlled.playerRoute?.speed).toBe(6);
    expect(controlled.playerRoute?.plan?.search).not.toBeNull();
    expect(controlled.playerRoute?.phase).toBe(0);
    const encoded = encodeEnvelope(createSessionSnapshot(run.session, controlled, 0));
    const decoded = decodeEnvelopeText(encoded);
    const restored = restoreSessionSnapshot(run.session, decoded);
    expect(restored.playerRoute?.speed).toBe(6);
    expect(restored.playerRoute?.plan?.search).not.toBeNull();
    const a = fold(run.session, controlled, 60);
    const b = fold(run.session, restored, 60);
    expect(motionProjection(b)).toEqual(motionProjection(a));

    const good = createSessionSnapshot(run.session, controlled, 0) as any;
    expect(validateSnapshot(good)).toBeNull();
    const badRoute = structuredClone(good);
    badRoute.mapRuntime.playerRoute.speed = 9;
    expect(validateSnapshot(badRoute)).toBe(
      "state.mapRuntime.playerRoute.speed: movement speed grade 1..6 required",
    );
    const badStep = structuredClone(good);
    badStep.mapRuntime.playerRoute.steps[0] = { control: { kind: "routeSpeed", value: 9 } };
    expect(validateSnapshot(badStep)).toBe(
      "state.mapRuntime.playerRoute.steps[0].control.value: movement speed grade 1..6 required",
    );
  });

  test("rewind over a player routeSpeed pathTo route restores identical state", () => {
    const driver = event("driver", 0, 0, [
      page("autorun", [
        { op: "moveControl", target: "player", control: { kind: "routeSpeed", value: 5, tilesPerSecond: 7 } },
        {
          op: "moveRoute",
          target: "player",
          route: {
            steps: [{ pathTo: { x: 9, y: 2 } }],
            repeat: false,
            skippable: false,
          },
        },
        { op: "selfSwitch", key: "A", value: true },
      ]),
      page("parallel", [], { condition: { selfSwitch: "A" } }),
    ]);
    const p = project([map("a", [driver])], { map: "a", x: 2, y: 2, dir: "right" });
    const tape = new Array<number>(600).fill(0);
    const options = {
      hz: 60,
      tapeHz: 60,
      idleFrames: 60_000,
      endHoldFrames: 60_000,
      rewindSeconds: 0.5,
      keyframeIntervalFrames: 17,
    };
    const keyed = new AttractController(p, tape, options);
    const fromZero = new AttractController(p, tape, { ...options, keyframeMaxBytes: 0 });
    keyed.startAttract();
    fromZero.startAttract();
    for (let i = 0; i < 140; i++) {
      keyed.step(0);
      fromZero.step(0);
    }
    keyed.step(BTN.L);
    fromZero.step(BTN.L);
    expect(keyed.state).toEqual(fromZero.state);
    expect(keyed.state.move.tx).toBe(9);
    expect(keyed.state.playerRoute?.tilesPerSecond).toBeUndefined();
  });

  test("routeSpeed routes are byte-deterministic at 60/30/20/4 Hz", () => {
    const runner = event("runner", 1, 5, [page("action", [], { moveSpeed: 4 })]);
    const booster = event("booster", 8, 7, [page("parallel", [
      { op: "wait", seconds: 12 / 60 },
      { op: "moveControl", target: { event: "runner" }, control: { kind: "routeSpeed", value: 3 } },
      { op: "exit" },
    ])]);
    const p = project([map("a", [controller([
      { op: "moveControl", target: { event: "runner" }, control: { kind: "routeSpeed", value: 6 } },
      {
        op: "moveRoute",
        target: { event: "runner" },
        route: {
          steps: ["moveRight", "moveRight", "moveRight", "moveRight", "moveRight", "moveRight"],
          repeat: false,
          skippable: false,
        },
      },
    ]), runner, booster])]);
    const projections = ([60, 30, 20, 4] as const).map((hz) => {
      const { session, state } = boot(p, hz);
      let out = action(session, state);
      out = foldReferenceTicks(session, out, 240 - session.ticksPerFrame);
      return motionProjection(out);
    });
    for (const value of projections.slice(1)) expect(value).toEqual(projections[0]);
    const ch = (projections[0] as any).chars.chars.runner;
    expect(ch.route).toBeNull();
    expect(ch.tx).toBe(7);
  });

  test("a latched routeSpeed survives save/load and resumes identically", () => {
    const runner = event("runner", 1, 5, [page("action", [], { moveSpeed: 4 })]);
    const p = project([map("a", [controller([
      { op: "moveControl", target: { event: "runner" }, control: { kind: "routeSpeed", value: 6 } },
      {
        op: "moveRoute",
        target: { event: "runner" },
        wait: false,
        route: { steps: ["moveRight", "moveRight", "moveRight", "moveRight"], repeat: false, skippable: false },
      },
    ]), runner])]);
    const run = boot(p);
    const controlled = fold(run.session, action(run.session, run.state), 6); // mid tile 2
    const encoded = encodeEnvelope(createSessionSnapshot(run.session, controlled, 0));
    const decoded = decodeEnvelopeText(encoded);
    const restored = restoreSessionSnapshot(run.session, decoded);
    expect(restored.chars.chars.runner?.route?.speed).toBe(6);
    const a = fold(run.session, controlled, 40);
    const b = fold(run.session, restored, 40);
    expect(motionProjection(b)).toEqual(motionProjection(a));

    const good = createSessionSnapshot(run.session, controlled, 0) as any;
    expect(validateSnapshot(good)).toBeNull();
    const badRoute = structuredClone(good);
    badRoute.mapRuntime.chars.chars.runner.route.speed = 9;
    expect(validateSnapshot(badRoute)).toBe(
      "state.mapRuntime.chars.chars.runner.route.speed: movement speed grade 1..6 required",
    );
    const badStep = structuredClone(good);
    badStep.mapRuntime.chars.chars.runner.route.steps[0] = { control: { kind: "routeSpeed", value: 9 } };
    expect(validateSnapshot(badStep)).toBe(
      "state.mapRuntime.chars.chars.runner.route.steps[0].control.value: movement speed grade 1..6 required",
    );
  });

  test("rewind over a routeSpeed route restores identical state", () => {
    const runner = event("runner", 1, 5, [page("action", [], { moveSpeed: 4 })]);
    const driver = event("driver", 0, 0, [
      page("autorun", [
        {
          op: "moveControl",
          target: { event: "runner" },
          control: { kind: "routeSpeed", value: 5, tilesPerSecond: 7 },
        },
        {
          op: "moveRoute",
          target: { event: "runner" },
          route: {
            steps: ["moveRight", "moveRight", "moveRight", "moveRight", "moveRight", "moveRight"],
            repeat: false,
            skippable: false,
          },
        },
        { op: "selfSwitch", key: "A", value: true },
      ]),
      page("parallel", [], { condition: { selfSwitch: "A" } }),
    ]);
    const p = project([map("a", [driver, runner])]);
    const tape = new Array<number>(600).fill(0);
    const options = {
      hz: 60,
      tapeHz: 60,
      idleFrames: 60_000,
      endHoldFrames: 60_000,
      rewindSeconds: 0.5,
      keyframeIntervalFrames: 17,
    };
    const keyed = new AttractController(p, tape, options);
    const fromZero = new AttractController(p, tape, { ...options, keyframeMaxBytes: 0 });
    keyed.startAttract();
    fromZero.startAttract();
    for (let i = 0; i < 140; i++) {
      keyed.step(0);
      fromZero.step(0);
    }
    keyed.step(BTN.L);
    fromZero.step(BTN.L);
    expect(keyed.state).toEqual(fromZero.state);
    expect(keyed.state.chars.chars.runner?.tx).toBe(7);
  });
});
