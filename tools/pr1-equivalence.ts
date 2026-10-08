// Reproducible main-vs-PR equivalence check for the tick-copy fold.
//
// Each scenario records a hash as a reducer state is produced, retains the
// actual object, then hashes every retained object again after the complete
// run. A later in-place write through a shared object therefore fails even
// when the final state happens to match. The same driver is loaded against
// two checkout roots and every produced/retained frame is compared.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Trace {
  name: string;
  frames: number;
  produced: string[];
  retained: string[];
  producedRoll: string;
  retainedRoll: string;
  meta: unknown;
}

interface RunReport {
  root: string;
  commit: string;
  traces: Trace[];
}

const BTN = {
  SELECT: 0x0001,
  UP: 0x0010,
  RIGHT: 0x0020,
  DOWN: 0x0040,
  LEFT: 0x0080,
  L: 0x0100,
  CIRCLE: 0x2000,
  CROSS: 0x4000,
} as const;

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (ArrayBuffer.isView(item) && !(item instanceof DataView)) {
      return Array.from(item as unknown as ArrayLike<number>);
    }
    // A stack frame's `unit` marker says "this program is a label-scope root"
    // (a page or a called common event). It is structural, not mutable state:
    // a build that adds the marker and one that does not hash the same
    // behavioral state once it is stripped.
    if (item !== null && typeof item === "object" && !Array.isArray(item) &&
        "prog" in item && "pc" in item && "unit" in item) {
      const { unit: _unit, ...rest } = item as Record<string, unknown>;
      return rest;
    }
    return item;
  });
}

function valueHash(value: unknown): string {
  return fnv1a(jsonText(value));
}

function rolling(hashes: readonly string[]): string {
  return fnv1a(hashes.join("\n"));
}

class Recorder<T> {
  private readonly refs: T[] = [];
  private readonly produced: string[] = [];

  constructor(
    readonly name: string,
    private readonly view: (value: T) => unknown = (value) => value,
  ) {}

  capture(value: T): void {
    this.refs.push(value);
    this.produced.push(valueHash(this.view(value)));
  }

  finish(meta: unknown = null): Trace {
    const retained = this.refs.map((value) => valueHash(this.view(value)));
    const dirty = this.produced.findIndex((hash, index) => retained[index] !== hash);
    if (dirty >= 0) {
      throw new Error(
        `${this.name}: retained state ${dirty} changed after publication ` +
        `(produced ${this.produced[dirty]}, final ${retained[dirty]})`,
      );
    }
    return {
      name: this.name,
      frames: this.produced.length,
      produced: this.produced,
      retained,
      producedRoll: rolling(this.produced),
      retainedRoll: rolling(retained),
      meta,
    };
  }
}

function moduleUrl(root: string, relative: string): string {
  return pathToFileURL(resolve(root, relative)).href;
}

async function load(root: string, relative: string): Promise<any> {
  return import(moduleUrl(root, relative));
}

function input(mask: number, previous = 0): Record<string, unknown> {
  const pressed = mask & ~previous;
  return {
    buttons: mask,
    confirmEdge: !!(pressed & BTN.CIRCLE),
    cancelEdge: !!(pressed & BTN.CROSS),
    upEdge: !!(pressed & BTN.UP),
    downEdge: !!(pressed & BTN.DOWN),
  };
}

function expandRuns(runs: readonly (readonly [number, number])[]): number[] {
  const masks: number[] = [];
  for (const [mask, count] of runs) for (let i = 0; i < count; i++) masks.push(mask);
  return masks;
}

function projectMap(id: string, events: any[], width = 8, height = 8): any {
  return {
    id,
    name: id,
    width,
    height,
    sheets: ["plain"],
    ground: new Array(width * height).fill("plain.0"),
    events,
  };
}

function plainProject(title: string, maps: any[], start: any, items: any[] = []): any {
  return {
    format: "rpgkit-project/v1",
    title,
    tileSize: 16,
    start,
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items,
    maps,
  };
}

/** Compare Sunstone's gameplay state while excluding its deliberately added
 * presentation-only theme. Audio semantics have dedicated reducer/host tests;
 * this older main-equivalence gate still needs to catch every other change. */
function sunstoneGameplayState(state: any): any {
  const withoutThemeLatch = (sw: any): any => {
    const self = { ...sw.self };
    delete self["village/ambient-music"];
    return { ...sw, self };
  };
  const sw = withoutThemeLatch(state.sw);
  const interp = { ...state.interp, sw: withoutThemeLatch(state.interp.sw) };
  delete interp.audio;
  delete interp.cues;
  const liveChars = { ...state.chars.chars };
  delete liveChars["ambient-music"];
  const chars = { ...state.chars, chars: liveChars };
  return { ...state, sw, chars, interp };
}

async function sunstoneTraces(root: string): Promise<Trace[]> {
  const [{ buildGame }, { playWinningRun }, { DEMO_TAPE_RUNS }, sessionMod, attractMod] = await Promise.all([
    load(root, "examples/sunstone/game-data.ts"),
    load(root, "examples/sunstone/journey.ts"),
    load(root, "examples/sunstone/demo-tape.ts"),
    load(root, "src/engine/session.ts"),
    load(root, "src/engine/attract.ts"),
  ]);
  const { createSession, startSession, stepSession } = sessionMod;
  const { AttractController } = attractMod;
  const project = buildGame().project;
  const traces: Trace[] = [];

  for (const hz of [60, 30, 20, 4]) {
    const planned = playWinningRun(hz);
    const session = createSession(project, hz);
    let state = startSession(project, session);
    let previous = 0;
    const recorder = new Recorder<any>(`sunstone-journey-${hz}hz`, sunstoneGameplayState);
    recorder.capture(state);
    for (const mask of planned.masks) {
      state = stepSession(session, state, input(mask, previous));
      previous = mask;
      recorder.capture(state);
    }
    const plannedEnd = planned.states[planned.states.length - 1];
    if (valueHash(state) !== valueHash(plannedEnd)) throw new Error(`sunstone journey ${hz} Hz replay diverged`);
    traces.push(recorder.finish({
      masks: planned.masks.length,
      masksHash: valueHash(planned.masks),
      milestones: planned.milestones,
      final: valueHash(sunstoneGameplayState(state)),
    }));
  }

  const tape = expandRuns(DEMO_TAPE_RUNS);
  {
    const session = createSession(project, 60);
    let state = startSession(project, session);
    let previous = 0;
    const recorder = new Recorder<any>("sunstone-tape-input-60hz", sunstoneGameplayState);
    recorder.capture(state);
    for (const mask of tape) {
      state = stepSession(session, state, input(mask, previous));
      previous = mask;
      recorder.capture(state);
    }
    traces.push(recorder.finish({
      masks: tape.length,
      masksHash: valueHash(tape),
      final: valueHash(sunstoneGameplayState(state)),
    }));
  }

  for (const hz of [60, 30, 20, 4]) {
    const controller = new AttractController(project, tape, {
      hz,
      tapeHz: 60,
      idleFrames: hz * 10,
      endHoldFrames: 120,
    });
    controller.startAttract();
    const recorder = new Recorder<any>(`sunstone-attract-${hz}hz`, (value) => ({
      ...value,
      state: sunstoneGameplayState(value.state),
    }));
    recorder.capture({ state: controller.state, status: controller.status(), modal: controller.presentedModal() });
    let loopFrame = -1;
    for (let frame = 0; frame < hz * 120; frame++) {
      const result = controller.step(0);
      recorder.capture({ state: result.state, status: result.status, modal: controller.presentedModal() });
      if (result.status.loopReset) {
        loopFrame = frame;
        break;
      }
    }
    if (loopFrame < 0) throw new Error(`sunstone attract ${hz} Hz did not complete a loop`);
    traces.push(recorder.finish({ loopFrame, tapeFrames: tape.length }));
  }
  return traces;
}

function numberArrayHash(values: ArrayLike<number>, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]! | 0;
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (value >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (value >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (value >>> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

async function growTrace(root: string): Promise<Trace> {
  const grow = await load(root, "examples/grow/grow.ts");
  const view = (state: any): unknown => {
    let grid = numberArrayHash(state.ground);
    grid = numberArrayHash(state.upper, grid);
    grid = numberArrayHash(state.road, grid);
    return {
      frame: state.frame,
      hz: state.hz,
      tick: state.tick,
      phase: state.phase,
      rng: state.rng,
      grid: grid.toString(16).padStart(8, "0"),
      tips: state.tips,
      roads: state.roads,
      houses: state.houses,
      farms: state.farms,
      villagers: state.villagers,
      decor: state.decor,
      chapter: state.chapter,
      frontierX: state.frontierX,
      roadFrontierX: state.roadFrontierX,
      cameraFromX: state.cameraFromX,
      cameraX: state.cameraX,
      grew: state.grew,
    };
  };
  const recorder = new Recorder<any>("grow-to-done", view);
  // The demo later moved to the causal rules; the original stamp rules
  // stayed selectable as STAMP_PARAMS and are what the baseline grows.
  let state = grow.createGrow(grow.STAMP_PARAMS ?? grow.DEFAULT_PARAMS);
  recorder.capture(state);
  for (let guard = 0; state.phase !== "done" && guard < 10_000; guard++) {
    state = grow.stepGrowTick(state);
    recorder.capture(state);
  }
  if (state.phase !== "done") throw new Error("grow did not reach done");
  return recorder.finish({ tick: state.tick, summary: grow.worldSummary(state) });
}

async function sessionFixtureTraces(root: string): Promise<Trace[]> {
  const [sessionMod, interpMod, meadowMod, eventMod, r2Mod, streamedMod] = await Promise.all([
    load(root, "src/engine/session.ts"),
    load(root, "src/engine/interpreter.ts"),
    load(root, "examples/meadow/mini-project.ts"),
    load(root, "tests/fixtures/event-model/project.ts"),
    load(root, "tests/fixtures/r2-ui/fixture-data.ts"),
    load(root, "tests/fixtures/streamed/fixture-data.ts"),
  ]);
  const { createSession, startSession, stepSession } = sessionMod;
  const traces: Trace[] = [];

  const run = (
    name: string,
    project: any,
    hz: number,
    masks: readonly number[],
    initialSwitches?: any,
  ): Trace => {
    const session = createSession(project, hz);
    let state = startSession(project, session, initialSwitches);
    let previous = 0;
    const recorder = new Recorder<any>(name);
    recorder.capture(state);
    for (const mask of masks) {
      state = stepSession(session, state, input(mask, previous));
      previous = mask;
      recorder.capture(state);
    }
    return recorder.finish({ hz, masksHash: valueHash(masks), final: valueHash(state) });
  };

  for (const hz of [60, 30, 20, 4]) {
    const masks = Array.from({ length: hz * 8 }, (_, frame) => {
      if (frame % Math.max(2, Math.floor(hz / 2)) === 0) return BTN.CIRCLE;
      const phase = Math.floor(frame / Math.max(1, hz)) % 4;
      return [BTN.UP, BTN.RIGHT, BTN.DOWN, BTN.LEFT][phase]!;
    });
    traces.push(run(`meadow-${hz}hz`, meadowMod.buildMiniProject(), hz, masks));
  }

  {
    const hz = 60;
    const masks = [
      ...new Array(hz).fill(0),
      ...new Array(hz).fill(BTN.RIGHT),
      ...Array.from({ length: hz * 2 }, (_, frame) => frame % 12 === 0 ? BTN.CIRCLE : 0),
    ];
    const sw = interpMod.createSwitchState({
      switches: { "local.stale": true },
      variables: { "local.stale": 99 },
    });
    traces.push(run("fixture-event-model", eventMod.buildEventModelProject(), hz, masks, sw));
  }

  {
    const masks = [
      ...new Array(80).fill(BTN.RIGHT),
      ...new Array(80).fill(BTN.LEFT),
      ...new Array(80).fill(0),
    ];
    traces.push(run("fixture-r2-ui", r2Mod.R2_UI_PROJECT, 60, masks));
  }

  {
    const masks = [...new Array(560).fill(BTN.RIGHT), ...new Array(80).fill(0)];
    traces.push(run("fixture-streamed", streamedMod.STREAMED_PROJECT, 60, masks));
  }
  return traces;
}

function repositoryFixture(): any {
  const ids = Array.from({ length: 24 }, (_, index) => `map_${String(index).padStart(2, "0")}`);
  const maps = ids.map((id, index) => projectMap(id, [
    {
      id: "door",
      x: 1,
      y: 0,
      pages: [{
        trigger: "action",
        commands: [
          { op: "variable", id: "visits", set: { op: "add", value: 1 } },
          { op: "transfer", map: ids[(index + 1) % ids.length]!, x: 1, y: 1, dir: "up", fade: 0.1 },
        ],
      }],
    },
    {
      id: "npc",
      x: 3,
      y: 3,
      pages: [{ trigger: "action", moveType: "random", commands: [] }],
    },
  ], 5, 5));
  return plainProject("repository parity", maps, { map: ids[0], x: 1, y: 1, dir: "up" });
}

async function repositoryTraces(root: string): Promise<Trace[]> {
  const [sessionMod, repositoryMod, splitMod] = await Promise.all([
    load(root, "src/engine/session.ts"),
    load(root, "src/engine/map-repository.ts"),
    load(root, "tools/lib/map-project.ts"),
  ]);
  const traces: Trace[] = [];
  const project = repositoryFixture();
  for (const hz of [60, 30, 20, 4]) {
    const split = splitMod.splitProjectMaps(project);
    const files = new Map(split.entries.map((entry: any) => [entry.path, entry.bytes]));
    const repository = repositoryMod.createJsonMapRepository(split.shell.mapIndex, {
      read: (entry: any) => files.get(entry),
    });
    const inlineSession = sessionMod.createSession(project, hz);
    const shardSession = sessionMod.createSession(split.shell, hz, repository);
    let inlineState = sessionMod.startSession(project, inlineSession);
    let shardState = sessionMod.startSession(split.shell, shardSession);
    const recorder = new Recorder<any>(`repository-inline-sharded-${hz}hz`);
    recorder.capture({ inline: inlineState, sharded: shardState });
    const frames = hz * 12;
    for (let frame = 0; frame < frames; frame++) {
      const referenceTick = Math.floor(frame * 60 / hz);
      const tick = referenceTick % 60;
      const nextInput = tick === 0
        ? { buttons: 0, confirmEdge: true }
        : tick >= 8 && tick < 14
          ? { buttons: BTN.DOWN }
          : tick >= 24 && tick < 30
            ? { buttons: BTN.UP }
            : { buttons: 0 };
      inlineState = sessionMod.stepSession(inlineSession, inlineState, nextInput);
      shardState = sessionMod.stepSession(shardSession, shardState, nextInput);
      if (valueHash(inlineState) !== valueHash(shardState)) {
        throw new Error(`repository parity ${hz} Hz diverged at frame ${frame}`);
      }
      recorder.capture({ inline: inlineState, sharded: shardState });
    }
    traces.push(recorder.finish({
      finalMap: shardState.mapId,
      visits: shardState.sw.variables.visits ?? 0,
      residentMaps: [...shardSession.maps.keys()],
    }));
  }
  return traces;
}

function parallelBattleEvent(id: string): any {
  return {
    id,
    x: 5,
    y: 5,
    pages: [
      {
        trigger: "parallel",
        commands: [
          {
            op: "battle",
            setup: { enemyHp: 1 },
            onWin: [{ op: "switch", id: `won.${id}`, value: true }],
          },
          { op: "switch", id: `done.${id}`, value: true },
        ],
      },
      { condition: { switch: `done.${id}` }, trigger: "action", commands: [] },
    ],
  };
}

async function battleTraces(root: string): Promise<Trace[]> {
  const [sessionMod, battleFixture, kb4Rules, kb4Fixture, attractMod] = await Promise.all([
    load(root, "src/engine/session.ts"),
    load(root, "tests/fixtures/toy-battle.ts"),
    load(root, "tests/fixtures/kb4-battle/rules.ts"),
    load(root, "tests/fixtures/kb4-battle/fixture-data.ts"),
    load(root, "src/engine/attract.ts"),
  ]);
  const traces: Trace[] = [];
  for (const hz of [60, 30, 20, 4]) {
    const events = [parallelBattleEvent("z-second"), parallelBattleEvent("a-first")];
    const project = plainProject("queued battles", [projectMap("a", events)], {
      map: "a", x: 2, y: 2, dir: "down",
    });
    const session = sessionMod.createSession(project, hz, { battle: battleFixture.toyBattleRules });
    let state = sessionMod.startSession(project, session);
    const recorder = new Recorder<any>(`battle-queued-${hz}hz`);
    const masks: number[] = [];
    recorder.capture(state);
    for (let frame = 0; frame < hz * 8; frame++) {
      const attack = state.scene !== null && battleFixture.toyState(state.scene.state).phase === "choice";
      const mask = attack ? BTN.CIRCLE : 0;
      masks.push(mask);
      state = sessionMod.stepSession(session, state, {
        buttons: mask,
        confirmEdge: attack,
        cancelEdge: false,
      });
      recorder.capture(state);
      if (
        state.scene === null && state.interp.pendingBattles.length === 0 &&
        (state.interp.pendingScenes?.length ?? 0) === 0 &&
        state.sw.switches["done.a-first"] && state.sw.switches["done.z-second"]
      ) break;
    }
    if (!state.sw.switches["done.a-first"] || !state.sw.switches["done.z-second"]) {
      throw new Error(`queued battles did not finish at ${hz} Hz`);
    }
    traces.push(recorder.finish({ masksHash: valueHash(masks), final: valueHash(state) }));
  }

  for (const hz of [60, 30, 20, 4]) {
    const map = {
      ...kb4Fixture.MAP,
      events: [kb4Fixture.battleEvent({ enemyHp: 4 })],
    };
    const project = plainProject("KB4 battle", [map], {
      map: kb4Fixture.MAP_ID, x: 2, y: 2, dir: "down",
    });
    const session = sessionMod.createSession(project, hz, { battle: kb4Rules.kb4BattleRules });
    let state = sessionMod.startSession(project, session);
    let previousMask = 0;
    const masks: number[] = [];
    const recorder = new Recorder<any>(`battle-kb4-win-${hz}hz`);
    recorder.capture(state);
    for (let frame = 0; frame < hz * 16; frame++) {
      const scene = state.scene ? kb4Rules.demoState(state.scene.state) : null;
      const readyBeat = scene?.phase === "beat" && scene.nowTick >= scene.beatStart + scene.beatDuration;
      const actionable = scene?.phase === "command" || readyBeat;
      const mask = actionable && previousMask === 0 ? BTN.CIRCLE : 0;
      masks.push(mask);
      state = sessionMod.stepSession(session, state, input(mask, previousMask));
      previousMask = mask;
      recorder.capture(state);
      if (state.scene === null && state.sw.switches["kb4-done"]) break;
    }
    if (!state.sw.switches["kb4-done"] || state.sw.variables["kb4.result"] !== "win") {
      throw new Error(`KB4 battle did not reach a win at ${hz} Hz`);
    }
    traces.push(recorder.finish({ masksHash: valueHash(masks), final: valueHash(state) }));
  }

  {
    const battle = {
      id: "battle",
      x: 1,
      y: 1,
      pages: [
        {
          trigger: "autorun",
          commands: [
            { op: "wait", seconds: 3 / 60 },
            {
              op: "battle",
              setup: { enemyHp: 1 },
              onWin: [{ op: "switch", id: "won", value: true }],
            },
            { op: "switch", id: "after", value: true },
          ],
        },
        { condition: { switch: "after" }, trigger: "action", commands: [] },
      ],
    };
    const project = plainProject("battle rewind", [projectMap("a", [battle])], {
      map: "a", x: 2, y: 2, dir: "down",
    });
    const controller = new attractMod.AttractController(project, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 4 / 60,
      battle: battleFixture.toyBattleRules,
    });
    controller.startPlay();
    const recorder = new Recorder<any>("battle-rewind-boundaries");
    const masks: number[] = [];
    recorder.capture({ state: controller.state, status: controller.status() });
    let completed = false;
    let postFrames = 0;
    let rewound = false;
    let replayCompleted = false;
    for (let frame = 0; frame < 240; frame++) {
      let mask = 0;
      const scene = controller.state.scene;
      if (scene && battleFixture.toyState(scene.state).phase === "choice") mask = BTN.CIRCLE;
      if (!rewound && completed && postFrames >= 2) {
        mask = BTN.L;
        rewound = true;
      }
      masks.push(mask);
      const result = controller.step(mask);
      recorder.capture({ state: result.state, status: result.status });
      if (!completed && result.state.sw.switches.after && result.state.scene === null) completed = true;
      else if (completed && !rewound) postFrames++;
      if (rewound && result.state.sw.switches.after && result.state.scene === null && !result.status.rewound) {
        replayCompleted = true;
        break;
      }
    }
    if (!rewound || !replayCompleted) throw new Error("battle rewind did not cross and replay both boundaries");
    traces.push(recorder.finish({ masksHash: valueHash(masks), final: valueHash(controller.state) }));
  }
  return traces;
}

async function shopTrace(root: string): Promise<Trace> {
  const [sessionMod, interpMod, saveMod, restoreMod] = await Promise.all([
    load(root, "src/engine/session.ts"),
    load(root, "src/engine/interpreter.ts"),
    load(root, "src/engine/save.ts"),
    load(root, "src/engine/save-restore.ts"),
  ]);
  const merchant = {
    id: "merchant",
    x: 1,
    y: 0,
    pages: [{
      trigger: "action",
      commands: [{
        op: "shop",
        id: "finite-shop",
        goods: [{ item: "tonic", price: 40, sellPrice: 20, stock: 1 }],
        sell: true,
        sellList: "hide",
      }],
    }],
  };
  const project = plainProject(
    "shop save parity",
    [projectMap("shop", [merchant], 3, 1)],
    { map: "shop", x: 0, y: 0, dir: "right" },
    [{ id: "tonic", name: "Tonic", sprite: "plain.0", price: 40 }],
  );
  const session = sessionMod.createSession(project, 60);
  let state = sessionMod.startSession(
    project,
    session,
    interpMod.createSwitchState({ gold: 100 }),
  );
  const recorder = new Recorder<any>("shop-save-roundtrip");
  recorder.capture(state);
  const step = (nextInput: Record<string, unknown>): void => {
    state = sessionMod.stepSession(session, state, { buttons: 0, ...nextInput });
    recorder.capture(state);
  };
  step({ confirmEdge: true }); // open buy list
  step({ confirmEdge: true }); // buy finite item
  step({ cancelEdge: true }); // leave
  step({}); // settle the action fiber
  const snapshot = saveMod.createSessionSnapshot(session, state, 0);
  const envelope = saveMod.encodeEnvelope(snapshot);
  // Saves later gained the optional map runtime (characters, player route,
  // fade); everything the baseline wrote must still encode byte for byte.
  const { mapRuntime: _mapRuntime, ...baselineFields } = snapshot;
  const baselineEnvelope = saveMod.encodeEnvelope(baselineFields);
  const restored = restoreMod.restoreSessionEnvelope(session, envelope);
  // A restore now keeps the saved characters where the baseline started
  // from an empty table that the next tick refilled from the map. Compare
  // the rest of the restored frame, and require the kept table to be the
  // saved one wherever the save carries it.
  if ("mapRuntime" in snapshot && valueHash(restored.chars) !== valueHash(state.chars)) {
    throw new Error("shop save roundtrip restored a different character table");
  }
  recorder.capture({ ...restored, chars: null });
  state = restored;
  step({ confirmEdge: true }); // reopen
  step({ downEdge: true }); // Sell
  step({ confirmEdge: true }); // enter sell stage
  step({ confirmEdge: true }); // sell tonic and restock
  if (state.sw.items.tonic !== 0 || state.sw.shopStock["finite-shop:tonic"] !== 1) {
    throw new Error("shop save roundtrip ended with the wrong inventory/stock");
  }
  return recorder.finish({ envelopeHash: valueHash(baselineEnvelope), final: valueHash(state) });
}

function dialogProject(): any {
  const intro = {
    id: "intro",
    x: 0,
    y: 0,
    pages: [{
      condition: { variable: { id: "intro", op: "==", value: 0 } },
      trigger: "parallel",
      commands: [
        { op: "wait", seconds: 31 / 60 },
        { op: "text", lines: ["Good morning!", "Mom is calling you."] },
        {
          op: "choices",
          prompt: "Skip the intro?",
          options: [
            { text: "No", commands: [{ op: "text", lines: ["The CEO speaks at length."] }] },
            { text: "Yes", commands: [] },
          ],
        },
        { op: "variable", id: "intro", set: { op: "set", value: 1 } },
      ],
    }],
  };
  const project = plainProject("dialog freeze", [projectMap("home", [intro], 9, 7)], {
    map: "home", x: 8, y: 4, dir: "left",
  });
  project.system = { messageBlocksPlayer: true };
  return project;
}

async function dialogTraces(root: string): Promise<Trace[]> {
  const sessionMod = await load(root, "src/engine/session.ts");
  const traces: Trace[] = [];
  for (const hz of [60, 30, 20, 4]) {
    const project = dialogProject();
    const session = sessionMod.createSession(project, hz);
    let state = sessionMod.startSession(project, session);
    const recorder = new Recorder<any>(`dialog-freeze-${hz}hz`);
    recorder.capture(state);
    const ticks = 60 / hz;
    for (let referenceTick = 0; referenceTick < 360; referenceTick += ticks) {
      const confirmEdge = referenceTick >= 60 && referenceTick % 30 === 0;
      state = sessionMod.stepSession(session, state, { buttons: BTN.LEFT, confirmEdge });
      recorder.capture(state);
    }
    traces.push(recorder.finish({ final: valueHash(state), intro: state.sw.variables.intro ?? 0 }));
  }
  return traces;
}

async function gitCommit(root: string): Promise<string> {
  const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr));
  return new TextDecoder().decode(proc.stdout).trim();
}

async function record(rootArg: string): Promise<RunReport> {
  const root = resolve(rootArg);
  const traces: Trace[] = [];
  const batches: Array<[string, () => Promise<Trace[]>]> = [
    ["sunstone", () => sunstoneTraces(root)],
    ["grow", async () => [await growTrace(root)]],
    ["fixtures", () => sessionFixtureTraces(root)],
    ["repository", () => repositoryTraces(root)],
    ["battle", () => battleTraces(root)],
    ["shop", async () => [await shopTrace(root)]],
    ["dialog", () => dialogTraces(root)],
  ];
  for (const [label, run] of batches) {
    process.stderr.write(`pr1-equivalence: ${await gitCommit(root)} ${label}\n`);
    traces.push(...await run());
  }
  return { root, commit: await gitCommit(root), traces };
}

function firstDifference(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function compare(baseline: RunReport, candidate: RunReport): void {
  if (baseline.traces.length !== candidate.traces.length) {
    throw new Error(`trace count differs: main ${baseline.traces.length}, candidate ${candidate.traces.length}`);
  }
  let total = 0;
  for (let i = 0; i < baseline.traces.length; i++) {
    const before = baseline.traces[i]!;
    const after = candidate.traces[i]!;
    if (before.name !== after.name) throw new Error(`trace ${i} name differs: ${before.name} vs ${after.name}`);
    if (jsonText(before.meta) !== jsonText(after.meta)) {
      throw new Error(`${before.name}: metadata differs\nmain=${jsonText(before.meta)}\ncandidate=${jsonText(after.meta)}`);
    }
    for (const key of ["produced", "retained"] as const) {
      const at = firstDifference(before[key], after[key]);
      if (at >= 0) {
        throw new Error(
          `${before.name}: ${key} frame ${at} differs ` +
          `(main ${before[key][at] ?? "<missing>"}, candidate ${after[key][at] ?? "<missing>"})`,
        );
      }
    }
    total += before.frames;
    console.log(
      `PR1_EQUIV scenario=${before.name} frames=${before.frames} ` +
      `produced=${before.producedRoll} retained=${before.retainedRoll}`,
    );
  }
  console.log(`PR1_EQUIV PASS scenarios=${baseline.traces.length} states=${total}`);
}

const [baselineRoot, candidateRoot, outputPath] = process.argv.slice(2);
if (!baselineRoot || !candidateRoot || !outputPath) {
  console.error("usage: bun tools/pr1-equivalence.ts BASELINE_ROOT CANDIDATE_ROOT OUTPUT.json");
  process.exit(2);
}

const baseline = await record(baselineRoot);
const candidate = await record(candidateRoot);
compare(baseline, candidate);
await Bun.write(resolve(outputPath), JSON.stringify({ baseline, candidate }, null, 2) + "\n");
