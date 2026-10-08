import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { AttractController } from "../src/engine/attract.ts";
import {
  createSessionSnapshot,
  encodeEnvelope,
  canSave,
} from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import {
  advanceScreenEffects,
  cameraFocusAt,
  colorAt,
  compositeScreenTints,
  screenEffectsAfterTransfer,
  screenShakeOffset,
  startCameraEffect,
  startScreenFlash,
  startScreenShake,
  startScreenTint,
  type ScreenEffectsState,
} from "../src/engine/screen.ts";
import {
  createSession,
  isSessionWorldIdle,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type { AnimationDef, Command, MapDef, Project } from "../src/engine/types.ts";
import schema from "../src/data/schema.json";
import { toyBattleRules } from "./fixtures/toy-battle.ts";

const PULSE: AnimationDef = {
  id: "pulse",
  sheet: "pulse.png",
  count: 2,
  frameDuration: 0.1,
  loop: true,
};

function project(commands: Command[]): Project {
  return {
    format: "rpgkit-project/v1",
    title: "screen effects",
    tileSize: 16,
    start: { map: "stage", x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [{
      id: "stage",
      name: "stage",
      width: 8,
      height: 8,
      sheets: ["plain"],
      ground: new Array(64).fill("plain.0"),
      events: [{
        id: "director",
        x: 1,
        y: 1,
        pages: [
          { trigger: "autorun", commands },
          { condition: { switch: "done" }, trigger: "action", commands: [] },
        ],
      }],
    }],
  };
}

function withAnimations(value: Project): Project {
  return { ...value, animations: [PULSE] };
}

function run(session: Session, state: SessionState, frames: number): SessionState {
  let next = state;
  for (let i = 0; i < frames; i++) next = stepSession(session, next, { buttons: 0 });
  return next;
}

describe("KS1 deterministic screen presentation", () => {
  test("the v1 schema accepts every screen command and rejects malformed payloads", () => {
    const commands: Command[] = [
      { op: "screenFade", direction: "out", duration: 0, color: { r: 0, g: 10, b: 20, a: 255 }, wait: true },
      { op: "screenTint", layer: "daylight", color: { r: 30, g: 40, b: 50, a: 60 }, duration: 1, wait: false },
      { op: "screenFlash", color: { r: 255, g: 250, b: 240, a: 200 }, intensity: 128, duration: 0.2, wait: true },
      { op: "screenShake", strength: 7.5, speed: 4, duration: 0.5, wait: true },
      { op: "camera", target: { x: 2, y: 4 }, duration: 1 },
      { op: "camera", target: { event: "director" }, duration: 0 },
      { op: "camera", target: "player", duration: 0 },
      { op: "balloon", target: "this", icon: "pulse", duration: 0.4, wait: true },
      { op: "balloon", target: "player" },
      { op: "screenBackdrop", layer: "cutscene", variant: "blue" },
      { op: "screenBackdrop", layer: "cutscene", variant: "blue", whenModalOpen: "ignore" },
      { op: "screenBackdrop", layer: "cutscene", variant: null },
    ];
    expect(validateSchema(schema, project(commands))).toEqual([]);

    const malformed: unknown[] = [
      { op: "screenFade", direction: "sideways", duration: 1 },
      { op: "screenTint", layer: "night", color: { r: 0, g: 0, b: 0, a: 256 }, duration: 1 },
      { op: "screenFlash", color: { r: 0, g: 0, b: 0, a: 255 }, intensity: 1.5, duration: 1 },
      { op: "screenShake", strength: -1, speed: 2, duration: 1 },
      { op: "camera", target: { x: -2, y: 4 }, duration: 1 },
      { op: "camera", target: { x: 1.5, y: 2 }, duration: 1 },
      { op: "balloon", target: "player", wait: true },
      { op: "balloon", target: "player", icon: "pulse", duration: 0, wait: true },
      { op: "screenBackdrop", layer: "", variant: "blue" },
      { op: "screenBackdrop", layer: "cutscene", variant: "blue", whenModalOpen: "replace" },
    ];
    for (const command of malformed) {
      const invalid = project([command as Command]);
      expect(validateSchema(schema, invalid).length, JSON.stringify(command)).toBeGreaterThan(0);
    }
  });

  test("a waited fade can save mid-effect and resumes on the same reference tick", () => {
    const p = project([
      { op: "screenFade", direction: "out", duration: 1, wait: true },
      { op: "switch", id: "done", value: true },
    ]);
    const session = createSession(p, 60);
    let uninterrupted = run(session, startSession(p, session), 20);

    expect(uninterrupted.interp.main?.mode).toBe("screenWait");
    expect(uninterrupted.interp.screen?.fade).toMatchObject({ total: 60, left: 41, clear: false });
    expect(canSave(uninterrupted.move, uninterrupted.interp, uninterrupted.scene)).toBe(true);

    const encoded = encodeEnvelope(createSessionSnapshot(session, uninterrupted, 0));
    const restored = restoreSessionEnvelope(session, encoded);
    expect(restored.interp).toEqual(uninterrupted.interp);

    uninterrupted = run(session, uninterrupted, 41);
    const resumed = run(session, restored, 41);
    expect(resumed).toEqual(uninterrupted);
    expect(resumed.interp.main).toBeNull();
    expect(resumed.sw.switches.done).toBe(true);
    expect(resumed.interp.screen?.fade).toMatchObject({
      from: { r: 0, g: 0, b: 0, a: 255 },
      to: { r: 0, g: 0, b: 0, a: 255 },
      total: 0,
      left: 0,
      clear: false,
    });
  });

  test("named tints compose in stable order and transparent targets prune", () => {
    let screen: ScreenEffectsState = {};
    startScreenTint(screen, "a", { r: 255, g: 0, b: 0, a: 128 }, 0);
    startScreenTint(screen, "z", { r: 0, g: 0, b: 255, a: 128 }, 0);
    expect(compositeScreenTints(screen.tints)).toEqual({ r: 85, g: 0, b: 170, a: 192 });

    startScreenTint(screen, "a", { r: 255, g: 0, b: 0, a: 0 }, 2);
    screen = advanceScreenEffects(screen)!;
    expect(colorAt(screen.tints!.a!)).toMatchObject({ r: 255, g: 0, b: 0, a: 64 });
    screen = advanceScreenEffects(screen)!;
    expect(screen.tints?.a).toBeUndefined();
    expect(screen.tints?.z).toBeDefined();
  });

  test("flash alpha and shake displacement are deterministic reference-tick functions", () => {
    let screen: ScreenEffectsState = {};
    startScreenFlash(screen, { r: 20, g: 40, b: 60, a: 200 }, 128, 60);
    expect(colorAt(screen.flash!)).toEqual({ r: 20, g: 40, b: 60, a: 100 });
    for (let i = 0; i < 30; i++) screen = advanceScreenEffects(screen)!;
    expect(colorAt(screen.flash!)).toEqual({ r: 20, g: 40, b: 60, a: 50 });

    startScreenShake(screen, 8, 1, 60);
    expect(screenShakeOffset(screen.shake)).toEqual({ x: 0, y: 0 });
    screen.shake!.left = 45;
    expect(screenShakeOffset(screen.shake)).toEqual({ x: 8, y: 0 });
    screen.shake!.left = 30;
    expect(screenShakeOffset(screen.shake)).toEqual({ x: 0, y: 0 });
    screen.shake!.left = 15;
    expect(screenShakeOffset(screen.shake)).toEqual({ x: -8, y: 0 });
  });

  test("camera tweens fixed world focus and can return to a moving player", () => {
    const screen: ScreenEffectsState = {};
    startCameraEffect(screen, "fixed", { x: 8, y: 8 }, { x: 108, y: 58 }, 20);
    screen.camera!.left = 10;
    expect(cameraFocusAt(screen.camera, { x: 20, y: 20 })).toEqual({ x: 58, y: 33 });

    startCameraEffect(screen, "follow", { x: 108, y: 58 }, { x: 20, y: 20 }, 20);
    screen.camera!.left = 10;
    // Follow samples the player's live position, so movement during the
    // return changes the destination without changing the saved start.
    expect(cameraFocusAt(screen.camera, { x: 40, y: 30 })).toEqual({ x: 74, y: 44 });
  });

  test("every timed screen command parks only its fiber until its duration", () => {
    const commands: Array<{ name: string; command: Command }> = [
      { name: "fade", command: { op: "screenFade", direction: "out", duration: 0.1, wait: true } },
      { name: "tint", command: { op: "screenTint", layer: "night", color: { r: 20, g: 30, b: 80, a: 128 }, duration: 0.1, wait: true } },
      { name: "flash", command: { op: "screenFlash", color: { r: 255, g: 255, b: 255, a: 255 }, intensity: 180, duration: 0.1, wait: true } },
      { name: "shake", command: { op: "screenShake", strength: 6, speed: 4, duration: 0.1, wait: true } },
      { name: "camera", command: { op: "camera", target: { x: 4, y: 4 }, duration: 0.1, wait: true } },
      { name: "balloon", command: { op: "balloon", target: "player", icon: "pulse", duration: 0.1, wait: true } },
    ];
    for (const { name, command } of commands) {
      const p = withAnimations(project([command, { op: "switch", id: "done", value: true }]));
      const session = createSession(p, 60);
      let state = run(session, startSession(p, session), 1);
      expect(state.interp.main?.mode, name).toBe("screenWait");
      expect(state.sw.switches.done, name).toBeUndefined();
      state = run(session, state, 6);
      expect(state.interp.main, name).toBeNull();
      expect(state.sw.switches.done, name).toBe(true);
    }
  });

  test("all descriptors start together and age without mutating their predecessor", () => {
    const p = withAnimations(project([
      { op: "screenFade", direction: "out", color: { r: 4, g: 8, b: 12, a: 240 }, duration: 0.5 },
      { op: "screenTint", layer: "night", color: { r: 10, g: 20, b: 80, a: 128 }, duration: 0.5 },
      { op: "screenFlash", color: { r: 255, g: 240, b: 220, a: 200 }, intensity: 128, duration: 0.5 },
      { op: "screenShake", strength: 7, speed: 3, duration: 0.5 },
      { op: "camera", target: { x: 4, y: 4 }, duration: 0.5 },
      { op: "balloon", target: "player", icon: "pulse", duration: 0.5 },
      { op: "screenBackdrop", layer: "cutscene", variant: "blue" },
      { op: "switch", id: "done", value: true },
    ]));
    const session = createSession(p, 60);
    const started = run(session, startSession(p, session), 1);
    const before = structuredClone(started.interp.screen);
    expect(started.interp.screen).toMatchObject({
      fade: { total: 30, left: 30 },
      tints: { night: { total: 30, left: 30 } },
      flash: { total: 30, left: 30 },
      shake: { total: 30, left: 30 },
      camera: { mode: "fixed", total: 30, left: 30, toX: 72, toY: 72 },
      balloons: { player: { icon: "pulse", age: 0, left: 30 } },
      backdrop: { layer: "cutscene", variant: "blue" },
    });

    const later = run(session, started, 15);
    expect(started.interp.screen).toEqual(before);
    expect(later.interp.screen).toMatchObject({
      fade: { left: 15 },
      tints: { night: { left: 15 } },
      flash: { left: 15 },
      shake: { left: 15 },
      camera: { left: 15 },
      balloons: { player: { age: 15, left: 15 } },
    });
  });

  test("transfer retains fixed camera and player balloon but clears map-local transients", () => {
    const p = withAnimations(project([
      { op: "screenFade", direction: "out", duration: 0 },
      { op: "screenTint", layer: "night", color: { r: 10, g: 20, b: 80, a: 128 }, duration: 0 },
      { op: "screenFlash", color: { r: 255, g: 255, b: 255, a: 255 }, intensity: 255, duration: 5 },
      { op: "screenShake", strength: 8, speed: 4, duration: 5 },
      { op: "camera", target: { x: 4, y: 4 }, duration: 5 },
      { op: "balloon", target: "player", icon: "pulse" },
      { op: "balloon", target: { event: "director" }, icon: "pulse" },
      { op: "screenBackdrop", layer: "cutscene", variant: "blue" },
      { op: "transfer", map: "next", x: 2, y: 2, dir: "down", fade: 0 },
    ]));
    const next: MapDef = {
      id: "next", name: "next", width: 8, height: 8, sheets: ["plain"],
      ground: new Array(64).fill("plain.0"), events: [],
    };
    p.maps.push(next);
    p.system = { transferPresentation: "retain" };
    const session = createSession(p, 60);
    const state = run(session, startSession(p, session), 1);
    expect(state.mapId).toBe("next");
    expect(state.interp.screen).toMatchObject({
      fade: { clear: false, left: 0 },
      tints: { night: { left: 0 } },
      camera: { mode: "fixed", toX: 72, toY: 72 },
      balloons: { player: { icon: "pulse", target: "player" } },
      backdrop: { layer: "cutscene", variant: "blue" },
    });
    expect(state.interp.screen?.flash).toBeUndefined();
    expect(state.interp.screen?.shake).toBeUndefined();
    expect(state.interp.screen?.balloons?.["event:director"]).toBeUndefined();
    expect(screenEffectsAfterTransfer(state.interp.screen, true)).toEqual(state.interp.screen);
  });

  test("transfer keeps the original per-map presentation lifetime without an opt-in", () => {
    const p = withAnimations(project([
      { op: "mapAnim", id: "pulse", anim: "pulse", target: "player", loop: true },
      { op: "camera", target: { x: 4, y: 4 }, duration: 0 },
      { op: "balloon", target: "player", icon: "pulse" },
      { op: "screenBackdrop", layer: "cutscene", variant: "blue" },
      { op: "transfer", map: "next", x: 2, y: 2, dir: "down", fade: 0 },
    ]));
    p.maps.push({
      id: "next", name: "next", width: 8, height: 8, sheets: ["plain"],
      ground: new Array(64).fill("plain.0"), events: [],
    });
    const session = createSession(p, 60);
    const state = run(session, startSession(p, session), 1);
    expect(state.mapId).toBe("next");
    expect(state.interp.anims).toBeUndefined();
    expect(state.interp.screen?.camera).toBeUndefined();
    expect(state.interp.screen?.balloons).toBeUndefined();
    expect(state.interp.screen?.backdrop).toEqual({ layer: "cutscene", variant: "blue" });
  });

  test("whenModalOpen ignore still replaces an exposed backdrop", () => {
    const p = project([
      { op: "screenBackdrop", layer: "cutscene", variant: "first" },
      { op: "screenBackdrop", layer: "cutscene", variant: "second", whenModalOpen: "ignore" },
      { op: "switch", id: "opened", value: true },
    ]);
    const session = createSession(p, 60);
    let state = run(session, startSession(p, session), 1);
    expect(state.sw.switches.opened).toBe(true);
    expect(state.interp.screen?.backdrop).toEqual({ layer: "cutscene", variant: "second" });

    const closer = project([
      { op: "screenBackdrop", layer: "cutscene", variant: "first" },
      { op: "screenBackdrop", layer: "cutscene", variant: null },
      { op: "screenBackdrop", layer: "cutscene", variant: "second", whenModalOpen: "ignore" },
    ]);
    const closerSession = createSession(closer, 60);
    state = run(closerSession, startSession(closer, closerSession), 1);
    expect(state.interp.screen?.backdrop).toEqual({ layer: "cutscene", variant: "second" });
  });

  test("screenBackdrop without whenModalOpen replaces below an active modal", () => {
    const p = project([
      { op: "screenBackdrop", layer: "cutscene", variant: "first" },
      { op: "text", lines: ["Keep this dialog open while another fiber replaces the backdrop."], cps: 1 },
    ]);
    p.maps[0]!.events!.push({
      id: "backdrop-replacer",
      x: 0,
      y: 0,
      pages: [{
        trigger: "parallel",
        blocks: false,
        commands: [
          { op: "wait", seconds: 0.05 },
          { op: "screenBackdrop", layer: "cutscene", variant: "second" },
          { op: "switch", id: "replacement-attempted", value: true },
          { op: "wait", seconds: 30 },
        ],
      }],
    });
    const session = createSession(p, 60);
    const state = run(session, startSession(p, session), 8);
    expect(state.sw.switches["replacement-attempted"]).toBe(true);
    expect(state.interp.modal?.kind).toBe("text");
    expect(state.interp.screen?.backdrop).toEqual({ layer: "cutscene", variant: "second" });
  });

  test("whenModalOpen ignore preserves an existing backdrop below an active modal", () => {
    const p = project([
      { op: "screenBackdrop", layer: "cutscene", variant: "first" },
      { op: "text", lines: ["Keep this dialog and backdrop open."], cps: 1 },
    ]);
    p.maps[0]!.events!.push({
      id: "backdrop-replacer",
      x: 0,
      y: 0,
      pages: [{
        trigger: "parallel",
        blocks: false,
        commands: [
          { op: "wait", seconds: 0.05 },
          { op: "screenBackdrop", layer: "cutscene", variant: "second", whenModalOpen: "ignore" },
          { op: "switch", id: "replacement-attempted", value: true },
          { op: "wait", seconds: 30 },
        ],
      }],
    });
    const session = createSession(p, 60);
    const state = run(session, startSession(p, session), 8);
    expect(state.sw.switches["replacement-attempted"]).toBe(true);
    expect(state.interp.modal?.kind).toBe("text");
    expect(state.interp.screen?.backdrop).toEqual({ layer: "cutscene", variant: "first" });
  });

  test("an active backdrop blocks free movement and worldIdle but not event execution", () => {
    const p = project([
      { op: "screenBackdrop", layer: "cutscene", variant: "blue" },
      { op: "switch", id: "done", value: true },
    ]);
    const session = createSession(p, 60);
    let state = run(session, startSession(p, session), 1);
    expect(state.sw.switches.done).toBe(true);
    expect(isSessionWorldIdle(state)).toBe(false);
    state = stepSession(session, state, { buttons: BTN.RIGHT });
    expect([state.move.tx, state.move.ty, state.move.moving]).toEqual([2, 2, false]);
  });

  test("a default-frozen battle pauses screen clocks while worldContinues advances them", () => {
    const p = project([
      { op: "screenTint", layer: "slow", color: { r: 10, g: 20, b: 30, a: 180 }, duration: 10 },
      { op: "battle", setup: { enemyHp: 99 } },
    ]);
    const frozenSession = createSession(p, 60, { battle: toyBattleRules });
    let frozen = run(frozenSession, startSession(p, frozenSession), 1);
    expect(frozen.scene).not.toBeNull();
    const frozenLeft = frozen.interp.screen!.tints!.slow!.left;
    frozen = run(frozenSession, frozen, 12);
    expect(frozen.interp.screen!.tints!.slow!.left).toBe(frozenLeft);

    const runningSession = createSession(p, 60, {
      battle: toyBattleRules,
      scene: { worldContinues: true },
    });
    let running = run(runningSession, startSession(p, runningSession), 1);
    expect(running.scene).not.toBeNull();
    const runningLeft = running.interp.screen!.tints!.slow!.left;
    running = run(runningSession, running, 12);
    expect(running.interp.screen!.tints!.slow!.left).toBe(runningLeft - 12);
  });

  test("event balloons track a moved target and pin to its last live cell", () => {
    const p = withAnimations(project([
      { op: "balloon", target: { event: "subject" }, icon: "pulse" },
      { op: "switch", id: "done", value: true },
    ]));
    p.maps[0]!.events!.push({
      id: "subject",
      x: 5,
      y: 5,
      pages: [{ trigger: "parallel", commands: [{ op: "wait", seconds: 10 }] }],
    });
    const session = createSession(p, 60);
    let state = run(session, startSession(p, session), 1);
    expect(state.interp.screen?.balloons?.["event:subject"]).toMatchObject({ x: 5, y: 5 });
    state.chars.chars.subject!.tx = 6;
    state.chars.chars.subject!.ty = 4;
    state.chars.chars.subject!.px = 6 * 16;
    state.chars.chars.subject!.py = 4 * 16;
    state = run(session, state, 1);
    expect(state.interp.screen?.balloons?.["event:subject"]).toMatchObject({ x: 6, y: 4 });
    delete state.chars.chars.subject;
    state.interp.erased["stage/subject"] = true;
    state = run(session, state, 1);
    expect(state.interp.screen?.balloons?.["event:subject"]).toMatchObject({ x: 6, y: 4 });
  });

  test("one virtual timeline produces the same settled screen state at 60/30/20/4 Hz", () => {
    const commands: Command[] = [
      { op: "screenFade", direction: "out", duration: 0.1, wait: true },
      { op: "screenTint", layer: "night", color: { r: 12, g: 24, b: 48, a: 96 }, duration: 0.1, wait: true },
      { op: "screenFlash", color: { r: 255, g: 255, b: 255, a: 255 }, intensity: 180, duration: 0.1, wait: true },
      { op: "screenShake", strength: 5, speed: 3, duration: 0.1, wait: true },
      { op: "camera", target: { x: 4, y: 4 }, duration: 0.1, wait: true },
      { op: "balloon", target: "player", icon: "pulse", duration: 0.1, wait: true },
      { op: "screenFade", direction: "in", duration: 0.1, wait: true },
      { op: "switch", id: "done", value: true },
    ];
    const outcomes = ([60, 30, 20, 4] as const).map((hz) => {
      const p = withAnimations(project(commands));
      const session = createSession(p, hz);
      const state = run(session, startSession(p, session), hz * 2);
      return {
        tick: state.interp.frame,
        screen: state.interp.screen,
        done: state.sw.switches.done,
      };
    });
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
    expect(outcomes[0]).toMatchObject({ tick: 120, done: true });
  });

  test("L rewind restores an in-flight effect from reducer history", () => {
    const p = project([
      { op: "screenTint", layer: "slow", color: { r: 60, g: 80, b: 120, a: 200 }, duration: 10 },
      { op: "camera", target: { x: 6, y: 6 }, duration: 10 },
      { op: "wait", seconds: 20 },
    ]);
    const options = { hz: 60, idleFrames: 60_000, rewindSeconds: 3, attractEnabled: false } as const;
    const rewound = new AttractController(p, [], options);
    for (let i = 0; i < 240; i++) rewound.step(0);
    expect(rewound.state.interp.screen?.tints?.slow.left).toBeLessThan(600);
    rewound.step(BTN.LTRIGGER);

    const direct = new AttractController(p, [], options);
    for (let i = 0; i < 60; i++) direct.step(0);
    expect(rewound.state).toEqual(direct.state);
    expect(rewound.state.interp.screen?.tints?.slow.left).toBeGreaterThan(500);
  });
});
