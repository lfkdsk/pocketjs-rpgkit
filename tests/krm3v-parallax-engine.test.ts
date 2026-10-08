import { describe, expect, test } from "bun:test";
import schema from "../src/data/schema.json" with { type: "json" };
import {
  cloneInterp,
  compile,
  createInterpState,
  createWorld,
  stepInterp,
  stepInterpWithExtensionsInPlace,
  type InterpInput,
} from "../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import {
  createSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
  type SaveSnapshot,
} from "../src/engine/save.ts";
import { restoreSessionSnapshot } from "../src/engine/save-restore.ts";
import { MAP_SCHEMA_HASH } from "../src/engine/schema-identity.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { decodeCompactMap } from "../src/engine/compact-map.ts";
import { encodeCompactMap } from "../tools/lib/compact-map.ts";
import type {
  Command,
  GameEvent,
  MapDef,
  Page,
  ParallaxDef,
  Project,
} from "../src/engine/types.ts";

const NO_EDGE = { confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

function page(trigger: Page["trigger"], commands: Command[]): Page {
  return { trigger, commands };
}

function event(id: string, x: number, y: number, pages: Page[]): GameEvent {
  return { id, x, y, pages };
}

function map(id: string, parallax?: ParallaxDef, events: GameEvent[] = []): MapDef {
  return {
    id,
    name: id,
    width: 4,
    height: 4,
    sheets: ["floor"],
    ground: new Array(16).fill("floor.0"),
    ...(parallax === undefined ? {} : { parallax }),
    events,
  };
}

function project(maps: MapDef[]): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Parallax engine",
    tileSize: 16,
    start: { map: maps[0]!.id, x: 1, y: 1, dir: "up" },
    sheets: [{ id: "floor", pak: "floor", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps,
  };
}

function frames(session: Session, state: SessionState, count: number): SessionState {
  let next = state;
  for (let i = 0; i < count; i++) next = stepSession(session, next, { buttons: 0 });
  return next;
}

function input(partial: Partial<InterpInput> = {}): InterpInput {
  return {
    ...NO_EDGE,
    playerCell: { x: 1, y: 1 },
    prevCell: { x: 1, y: 2 },
    facing: 2,
    ...partial,
  };
}

describe("KRM3V parallax schema and map entry", () => {
  test("schema accepts the frozen map and command shapes and rejects editor-only command data", () => {
    const parallax: ParallaxDef = {
      image: "clouds",
      loopX: true,
      loopY: false,
      sx: -3,
      sy: 0.5,
      zero: true,
      showInEditor: false,
    };
    const command: Command = {
      op: "changeParallax",
      image: "mist",
      loopX: false,
      loopY: true,
      sx: 0,
      sy: 4,
      zero: false,
    };
    const valid = project([map("a", parallax, [event("change", 1, 0, [page("action", [command])])])]);
    expect(validateSchema(schema, valid)).toEqual([]);

    const badCommand = structuredClone(valid) as any;
    badCommand.maps[0].events[0].pages[0].commands[0].showInEditor = true;
    expect(validateSchema(schema, badCommand).length).toBeGreaterThan(0);

    const missingSpeed = structuredClone(valid) as any;
    delete missingSpeed.maps[0].parallax.sx;
    expect(validateSchema(schema, missingSpeed).length).toBeGreaterThan(0);
  });

  test("start, transfer, and revisit initialize the destination map default at phase zero", () => {
    const aDefault: ParallaxDef = {
      image: "a-default", loopX: true, loopY: false, sx: 2, sy: 8,
      zero: true, showInEditor: true,
    };
    const bDefault: ParallaxDef = {
      image: "b-default", loopX: false, loopY: true, sx: 10, sy: -4,
    };
    const a = map("a", aDefault, [event("to-b", 1, 0, [page("action", [
      { op: "changeParallax", image: "temporary", loopX: true, loopY: true, sx: 20, sy: 30 },
      { op: "transfer", map: "b", x: 1, y: 1, dir: "up" },
    ])])]);
    const b = map("b", bDefault, [event("to-a", 1, 0, [page("action", [
      { op: "transfer", map: "a", x: 1, y: 1, dir: "up" },
    ])])]);
    const p = project([a, b]);
    const session = createSession(p);
    let state = startSession(p, session);

    expect(state.interp.parallax).toEqual({
      image: "a-default", loopX: true, loopY: false, sx: 2, sy: 8,
      zero: true, phaseX: 0, phaseY: 0,
    });
    state = frames(session, state, 2);
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    expect(state.mapId).toBe("b");
    expect(state.interp.parallax).toEqual({
      image: "b-default", loopX: false, loopY: true, sx: 10, sy: -4,
      phaseX: 0, phaseY: 0,
    });

    state = frames(session, state, 2);
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    expect(state.mapId).toBe("a");
    expect(state.interp.parallax).toEqual({
      image: "a-default", loopX: true, loopY: false, sx: 2, sy: 8,
      zero: true, phaseX: 0, phaseY: 0,
    });

    const none = project([map("none", {
      image: null, loopX: true, loopY: true, sx: 9, sy: 9, showInEditor: true,
    })]);
    const noneSession = createSession(none);
    expect(startSession(none, noneSession).interp.parallax).toBeUndefined();
    expect(createInterpState().parallax).toBeUndefined();
  });
});

describe("KRM3V parallax reducer", () => {
  test("only looped axes advance by half their signed speed at the fixed reference rate", () => {
    const p = project([map("a", {
      image: "fog", loopX: true, loopY: false, sx: 3, sy: 100,
    })]);
    const samples = ([60, 30, 20, 4] as const).map((hz) => {
      const session = createSession(p, hz);
      const state = frames(session, startSession(p, session), hz);
      return { frame: state.interp.frame, parallax: state.interp.parallax };
    });
    expect(samples.slice(1)).toEqual([samples[0], samples[0], samples[0]]);
    expect(samples[0]).toEqual({
      frame: 60,
      parallax: {
        image: "fog", loopX: true, loopY: false, sx: 3, sy: 100,
        phaseX: 90, phaseY: 0,
      },
    });
  });

  test("changeParallax atomically preserves only axes looped before and after, and null removes state", () => {
    const authored = map("a", {
      image: "old", loopX: true, loopY: true, sx: 2, sy: 4, zero: true,
    }, [event("change", 1, 1, [page("playerTouch", [{
      op: "changeParallax",
      image: "new",
      loopX: true,
      loopY: false,
      sx: -6,
      sy: 12,
      zero: false,
    }])])]);
    const before = createInterpState(undefined, authored.parallax);
    before.parallax!.phaseX = 8;
    before.parallax!.phaseY = 10;
    const changed = stepInterp(createWorld(authored), before, input());
    expect(changed.parallax).toEqual({
      image: "new", loopX: true, loopY: false, sx: -6, sy: 12,
      zero: false, phaseX: 9, phaseY: 0,
    });

    const remover = map("a", undefined, [event("remove", 1, 1, [page("playerTouch", [{
      op: "changeParallax", image: null, loopX: true, loopY: true, sx: 1, sy: 1,
    }])])]);
    expect(stepInterp(createWorld(remover), changed, input()).parallax).toBeUndefined();
  });

  test("an empty-string parallax image clears state like null and never accumulates phase", () => {
    // An authored map default with an empty name installs no state at all:
    // a hidden-but-scrolling parallax would accumulate phase for an image
    // that can never render.
    expect(createInterpState(undefined, {
      image: "", loopX: true, loopY: true, sx: 4, sy: 8,
    }).parallax).toBeUndefined();

    // changeParallax with an empty name removes a live parallax. This is a
    // kit decision (an empty name means "cleared"): MV keeps the empty name
    // and keeps scrolling the hidden layer instead.
    const before = createInterpState(undefined, {
      image: "fog", loopX: true, loopY: true, sx: 2, sy: 4,
    });
    before.parallax!.phaseX = 6;
    const clearer = map("a", undefined, [event("clear", 1, 1, [page("playerTouch", [{
      op: "changeParallax", image: "", loopX: true, loopY: true, sx: 1, sy: 1,
    }])])]);
    expect(stepInterp(createWorld(clearer), before, input()).parallax).toBeUndefined();
  });

  test("a fatal interpreter tick still advances parallax without replacing its object", () => {
    const state = createInterpState(undefined, {
      image: "storm", loopX: true, loopY: true, sx: -1, sy: 5,
    });
    state.error = { kind: "content", message: "frozen fibers" };
    const owned = state.parallax!;
    const world = createWorld(map("a"));
    const ext = world.extensions.initial;
    stepInterpWithExtensionsInPlace(world, state, input(), ext);
    expect(state.parallax).toBe(owned);
    expect(state.parallax).toMatchObject({ phaseX: -0.5, phaseY: 2.5 });
    expect(state.frame).toBe(1);
  });
});

function snapshotWith(prog: unknown[]): SaveSnapshot {
  const snapshot = createSnapshot(
    "a",
    initialMovement(1, 1, 2, { tile: 16, speed: 2 }),
    createInterpState(),
    0,
  );
  snapshot.interp.parallels["a/p"] = {
    key: "a/p", pageIndex: 0, parallel: true,
    stack: [{ prog, pc: 0 }], mode: "run", since: 0, erase: false,
  } as never;
  return snapshot;
}

describe("KRM3V parallax persistence and compact maps", () => {
  test("clone/save round-trip phase and deep validation covers runtime and compiled state", () => {
    const state = createInterpState(undefined, {
      image: "clouds", loopX: true, loopY: true, sx: 1.5, sy: -3, zero: true,
    });
    state.parallax!.phaseX = 12.25;
    state.parallax!.phaseY = -7.5;
    const cloned = cloneInterp(state);
    cloned.parallax!.phaseX = 99;
    expect(state.parallax!.phaseX).toBe(12.25);

    const snapshot = createSnapshot(
      "a",
      initialMovement(1, 1, 2, { tile: 16, speed: 2 }),
      state,
      0,
    );
    expect(validateSnapshot(snapshot)).toBeNull();
    expect(decodeEnvelopeText(encodeEnvelope(snapshot)).interp.parallax).toEqual(state.parallax);

    const malformed = structuredClone(snapshot) as any;
    malformed.interp.parallax.phaseY = "bad";
    expect(validateSnapshot(malformed)).toStartWith("state.interp.parallax.phaseY");
    const editorOnly = structuredClone(snapshot) as any;
    editorOnly.interp.parallax.showInEditor = true;
    expect(validateSnapshot(editorOnly)).toStartWith("state.interp.parallax.showInEditor");

    const validProgram = snapshotWith(compile([{
      op: "changeParallax", image: "rain", loopX: true, loopY: false, sx: 2, sy: 0,
    }]));
    expect(validateSnapshot(validProgram)).toBeNull();
    const badProgram = snapshotWith([{
      op: "changeParallax", image: "rain", loopX: true, loopY: false, sx: 2, sy: "fast",
    }]);
    expect(validateSnapshot(badProgram)).toContain("sx/sy finite numbers");
    const editorProgram = snapshotWith([{
      op: "changeParallax", image: "rain", loopX: true, loopY: false, sx: 2, sy: 0,
      showInEditor: true,
    }]);
    expect(validateSnapshot(editorProgram)).toContain("unknown changeParallax field");
  });

  test("compact map encoding preserves authored parallax and validates its envelope field", () => {
    const authored = map("a", {
      image: "clouds", loopX: true, loopY: false, sx: -3, sy: 0,
      zero: true, showInEditor: false,
    });
    const encoded = encodeCompactMap(authored);
    expect(encoded.value.a).toEqual(authored.parallax);
    expect(decodeCompactMap(JSON.parse(encoded.text))).toEqual(authored);

    const malformed = JSON.parse(encoded.text) as any;
    malformed.a.extra = true;
    expect(() => decodeCompactMap(malformed)).toThrow("unknown parallax field");
  });
});

describe("KRM3V empty-name parallax save recovery", () => {
  /** A checksum-valid snapshot carrying an empty-name parallax with phase
   *  already accumulated — what an older build (or a hand edit) could save.
   *  The decode path must normalize it to no parallax. */
  function emptyNameSnapshot(): SaveSnapshot {
    const snapshot = createSnapshot(
      "a",
      initialMovement(1, 1, 2, { tile: 16, speed: 2 }),
      createInterpState(),
      0,
    );
    snapshot.interp.parallax = {
      image: "", loopX: true, loopY: true, sx: 4, sy: 8, phaseX: 12, phaseY: 24,
    };
    return snapshot;
  }

  test("a save encoded under the current schema identity restores no parallax and never accumulates", () => {
    const content = { manifest: "test-manifest", schema: MAP_SCHEMA_HASH };
    const session = createSession(project([map("a")]));
    const decoded = decodeEnvelopeText(encodeEnvelope(emptyNameSnapshot(), content), content);
    expect(decoded.interp.parallax).toBeUndefined();
    const restored = restoreSessionSnapshot(session, decoded);
    expect(restored.interp.parallax).toBeUndefined();
    // One tick on the restored state: no parallax means no phase growth.
    const next = stepSession(session, restored, { buttons: 0 });
    expect(next.interp.parallax).toBeUndefined();
  });
});
