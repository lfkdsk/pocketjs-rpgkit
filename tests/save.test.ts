// tests/rpgkit-save.test.ts — P1⑤ save snapshot, envelope, save code.
//
// Pure-core coverage (no wasm, no host):
//   - canSave: the safe-point gate (tile boundary, no modal/fiber/request)
//   - envelope round-trip with a rich interpreter state (fibers + compiled
//     stacks, modal, latches, RNG cursor, gold/items/variables)
//   - canonical-JSON checksum: insertion-order independent, every tamper
//     is refused
//   - save code: URL-safe base64 alphabet, round trip, whitespace/paste
//     tolerance, bad-alphabet/truncated refusal
//   - version/format/shape refusal with typed SaveError codes
//   - FNV-1a cross-check against the sim host's framebuffer fnv1a
//   - store helpers over an in-memory SaveStore
//
// The worldline proof (save mid-run, continue, load, replay the same
// inputs -> byte-identical states and pixels) lives in rpgkit-sim.test.ts,
// driven through the actual bundle the device runs.

import { describe, expect, test } from "bun:test";
import { fnv1a as simFnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import {
  canSave,
  canonicalJson,
  createSnapshot,
  decodeEnvelopeText,
  decodeSaveCode,
  encodeEnvelope,
  encodeSaveCode,
  SAVE_CODE_COMPRESSED_PREFIX,
  fnv1aBytes,
  fnv1aText,
  loadFromStore,
  saveToStore,
  SAVE_FORMAT,
  SAVE_VERSION,
  sessionStateFingerprint,
  SaveError,
  type SaveErrorCode,
  type SaveSnapshot,
  slotPath,
  summarizeEnvelope,
  type SaveStore,
} from "../src/engine/save.ts";
import {
  createInterpState,
  createSwitchState,
  createWorld,
  randInt,
  stepInterp,
  type InterpState,
  type World,
} from "../src/engine/interpreter.ts";
import { initialMovement, stepMovement, type MovementState } from "../src/engine/movement.ts";
import { buildPassage } from "../src/engine/passability.ts";
import { buildMiniProject } from "../examples/meadow/mini-project.ts";
import type { MapDef, Project } from "../src/engine/types.ts";
import { createSession, startSession, stepSession, type Session, type SessionState } from "../src/engine/session.ts";
import { MAP_SCHEMA_HASH, type MapContentIdentity } from "../src/engine/map-repository.ts";

// --- harness: fold the real reducers into a rich saveable state -----------

const SPEED = 2;
const MOVE_CFG = { tile: 16, speed: SPEED };

const EXAMPLE_PROJECT = buildMiniProject();
const EXAMPLE_MAP: MapDef = EXAMPLE_PROJECT.maps[0]!;
const EXAMPLE_TABLE = buildPassage(
  EXAMPLE_MAP,
  new Map(EXAMPLE_PROJECT.sheets.map((sh) => [sh.id, sh])),
);
void EXAMPLE_TABLE;

function restPlayer(): MovementState {
  return initialMovement(10, 7, 2, MOVE_CFG);
}

const START_CELL = { x: 10, y: 7 };

/** Error code a throwing decode call raises (asserts it threw at all). */
function thrownCode(fn: () => unknown): SaveErrorCode {
  try {
    fn();
    throw new Error("expected a SaveError");
  } catch (e) {
    if (!(e instanceof SaveError)) throw e;
    return e.code;
  }
}

// The save suite drives only the signpost flow: a filtered event map keeps
// unrelated example fibers (the meadow/brook parallel) out of the folded
// state these snapshots encode. Inline-event cases build their own maps.
const SIGNPOST_MAP: MapDef = {
  ...EXAMPLE_MAP,
  events: EXAMPLE_MAP.events!.filter((e) => e.id === "signpost"),
};

function demoWorld(): World {
  return createWorld(SIGNPOST_MAP, EXAMPLE_PROJECT.commonEvents ?? [], 60);
}

function foldInterp(
  interp0: InterpState,
  frames: readonly { confirm?: boolean; down?: boolean }[],
): InterpState {
  let interp = interp0;
  for (const e of frames) {
    interp = stepInterp(demoWorld(), interp, {
      confirmEdge: !!e.confirm,
      playerCell: START_CELL,
      prevCell: START_CELL,
      facing: 2,
    });
  }
  return interp;
}

/** Signpost tape (no DOWN): open f0, skip f2, choices f4, select the
 *  "Read note" branch f8, skip branch f10, close f12. Leaves switch
 *  note-read=true, self switch A on meadow/signpost. */
const SIGNPOST_READ: readonly { confirm?: boolean }[] = [
  { confirm: true }, {}, { confirm: true }, {}, { confirm: true }, {}, {}, {},
  { confirm: true }, {}, { confirm: true }, {}, { confirm: true },
];

describe("P1⑤ save — safe-point gate", () => {
  test("a resting player with no fiber is saveable; mid-step is not", () => {
    const player = restPlayer();
    const interp = createInterpState();
    expect(canSave(player, interp)).toBe(true);

    const stepped = stepMovement(player, BTN.RIGHT, EXAMPLE_TABLE, MOVE_CFG);
    expect(stepped.moving).toBe(true);
    expect(canSave(stepped, interp)).toBe(false);
  });

  test("an open modal (blocking fiber) is not a save point", () => {
    const player = restPlayer();
    const interp = foldInterp(createInterpState(), [{ confirm: true }]);
    expect(interp.modal).not.toBeNull();
    expect(canSave(player, interp)).toBe(false);
    expect(() => createSnapshot("meadow", player, interp, 0)).toThrow(/tile boundary/);
  });

  test("a parked external request is not a save point", () => {
    const player = restPlayer();
    let interp = createInterpState();
    interp.pendingTransfer = { fiber: "x", map: "m", x: 0, y: 0, dir: "keep", fadeFrames: 0 };
    expect(canSave(player, interp)).toBe(false);
  });

  test("a pending placement is not a save point", () => {
    const interp = createInterpState();
    interp.pendingPlacements.push({ eventId: "npc", x: 3, y: 4, dir: null });
    expect(canSave(restPlayer(), interp)).toBe(false);
  });

  test("a fatal interpreter error is not a save point (review 1274 B1)", () => {
    const interp = createInterpState();
    expect(canSave(restPlayer(), interp)).toBe(true);
    interp.error = { kind: "runaway", message: "interpreter: runaway program in m/x" };
    expect(canSave(restPlayer(), interp)).toBe(false);
    expect(() => createSnapshot("meadow", restPlayer(), interp, 0)).toThrow(/tile boundary/);
  });
});

describe("P1⑤ save — envelope round trip", () => {
  test("an exact reviewed predecessor identity loads but new saves stamp only the current identity", () => {
    const old = {
      manifest: "1".repeat(64),
      schema: "c5d8a3f0ed118bfd8d99f2a0b4dda7479918506c3728d09097f1ef662788af2c",
    };
    const current: MapContentIdentity = {
      manifest: "2".repeat(64),
      schema: MAP_SCHEMA_HASH,
      compatible: [old],
    };
    const snapshot = createSnapshot("meadow", restPlayer(), createInterpState(), 0);
    const oldEnvelope = encodeEnvelope(snapshot, old);

    expect(decodeEnvelopeText(oldEnvelope, current)).toEqual(snapshot);
    expect(decodeSaveCode(encodeSaveCode(snapshot, old), current)).toEqual(snapshot);
    expect(() => decodeEnvelopeText(oldEnvelope, {
      ...current,
      compatible: [{ ...old, manifest: "3".repeat(64) }],
    })).toThrow("save map manifest hash does not match this content build");
    const wrongSchema = encodeEnvelope(snapshot, { ...old, schema: "4".repeat(64) });
    expect(() => decodeEnvelopeText(wrongSchema, current)).toThrow(
      "save map manifest hash does not match this content build",
    );

    const rewritten = JSON.parse(encodeEnvelope(snapshot, current)) as { content: unknown };
    expect(rewritten.content).toEqual({ manifest: current.manifest, schema: current.schema });
  });

  test("rich state (switches, self, items, gold, rng, latches) survives", () => {
    let interp = createInterpState(createSwitchState({ gold: 120, items: { key: 2 } }));
    interp = foldInterp(interp, SIGNPOST_READ);
    expect(interp.main).toBeNull();
    expect(interp.sw.switches["note-read"]).toBe(true);
    expect(interp.sw.self["meadow/signpost"]).toBe("A");
    expect(interp.sw.gold).toBe(120);
    expect(interp.sw.items["key"]).toBe(2);

    // Advance the RNG cursor the way a variable-random command would.
    const r = randInt(interp.sw.rng, 1, 6);
    interp.sw.rng = r.next;
    interp.sw.variables["roll"] = r.value;

    const snap = createSnapshot("meadow", restPlayer(), interp, 0);
    const back = decodeEnvelopeText(encodeEnvelope(snap));

    expect(back).toEqual(snap);
    expect(back.map).toBe("meadow");
    expect(back.player.tx).toBe(10);
    expect(back.interp.frame).toBe(snap.interp.frame);
    expect(back.interp.sw).toEqual(snap.interp.sw);
    expect(back.interp.sw.rng).toBe(snap.interp.sw.rng);
    expect(back.interp.sw.variables["roll"]).toBe(snap.interp.sw.variables["roll"]);
    expect(back.held).toBe(0);
    // Transient fields are normalized off the snapshot.
    expect(back.interp.cues).toEqual([]);
    expect(back.interp.pendingTransfer).toBeNull();
  });

  test("a PARALLEL fiber with its compiled stack round-trips and resumes", () => {
    const events: MapDef["events"] = [
      {
        id: "clock",
        x: 1,
        y: 1,
        pages: [
          {
            trigger: "parallel",
            sprite: null,
            commands: [
              { op: "variable", id: "ticks", set: { op: "add", value: 1 } },
              { op: "wait", seconds: 0.5 },
              { op: "exit" },
            ],
          },
        ],
      },
    ];
    const map: MapDef = { ...EXAMPLE_MAP, events };
    const world = createWorld(map, EXAMPLE_PROJECT.commonEvents ?? [], 60);
    let interp = createInterpState();
    interp = stepInterp(world, interp, { playerCell: START_CELL, prevCell: START_CELL, facing: 0 });
    interp = stepInterp(world, interp, { playerCell: START_CELL, prevCell: START_CELL, facing: 0 });
    expect(Object.keys(interp.parallels)).toHaveLength(1);

    const snap = createSnapshot(map.id, restPlayer(), interp, 0);
    const back = decodeEnvelopeText(encodeEnvelope(snap));
    expect(back.interp.parallels).toEqual(snap.interp.parallels);
    const fiberKey = Object.keys(back.interp.parallels)[0]!;
    const stack = back.interp.parallels[fiberKey]!.stack[0]!;
    expect(stack.prog[stack.pc]?.op).toBe("wait");

    // Resume the restored state: the wait elapses, the fiber restarts and
    // increments ticks again — deterministic continuation of the stack.
    let resumed = back.interp;
    for (let i = 0; i < 40; i++) {
      resumed = stepInterp(world, resumed, { playerCell: START_CELL, prevCell: START_CELL, facing: 0 });
    }
    expect(resumed.sw.variables["ticks"]).toBeGreaterThanOrEqual(2);
  });

  test("canonical checksum is independent of record insertion order", () => {
    const snap = createSnapshot("m", restPlayer(), createInterpState(), 0);
    // Re-insert sw fields in a different order by round-tripping through
    // canonical JSON: checksums stay equal.
    const reordered = JSON.parse(canonicalJson(snap)) as typeof snap;
    expect(fnv1aText(canonicalJson(reordered))).toBe(fnv1aText(canonicalJson(snap)));
    expect(encodeEnvelope(snap)).toContain('"checksum"');
  });

  test("every state tamper is refused with 'checksum'", () => {
    const snap = createSnapshot("m", restPlayer(), createInterpState(), 0);
    const tamper = (mutate: (e: { state: SaveSnapshot }) => void) => {
      const e = JSON.parse(encodeEnvelope(snap)) as { state: SaveSnapshot };
      mutate(e);
      expect(thrownCode(() => decodeEnvelopeText(JSON.stringify(e)))).toBe("checksum");
    };
    tamper((e) => { e.state.interp.sw.gold = 9999; });
    tamper((e) => { e.state.player.ty = 8; });
    tamper((e) => { e.state.map = "other-map"; });
  });

  test("truncated / non-JSON envelopes get typed refusals", () => {
    const raw = encodeEnvelope(createSnapshot("m", restPlayer(), createInterpState(), 0));
    expect(() => decodeEnvelopeText(raw.slice(0, 40))).toThrow(SaveError);
    expect(thrownCode(() => decodeEnvelopeText("not json{"))).toBe("bad-json");
  });

  test("version, format, and shape mismatches get distinct codes", () => {
    const env = JSON.parse(
      encodeEnvelope(createSnapshot("m", restPlayer(), createInterpState(), 0)),
    ) as Record<string, unknown>;
    expect(thrownCode(() => decodeEnvelopeText(JSON.stringify({ ...env, version: 2 })))).toBe("version");
    expect(thrownCode(() => decodeEnvelopeText(JSON.stringify({ ...env, format: "rpgkit-save/v0" })))).toBe("format");
    const noState = { format: SAVE_FORMAT, version: SAVE_VERSION, checksum: "00000000" };
    expect(thrownCode(() => decodeEnvelopeText(JSON.stringify(noState)))).toBe("shape");
  });

  // Per-visit interpreter fields serialize too.
  test("placements and a held cross-event input lock round-trip", () => {
    const interp = createInterpState();
    interp.inputLocked = true;
    interp.placements.npc = { x: 4, y: 6, dir: "left" };
    interp.placements.other = { x: 0, y: 0, dir: null };
    const snap = createSnapshot("meadow", restPlayer(), interp, 0);
    const back = decodeEnvelopeText(encodeEnvelope(snap));
    expect(back).toEqual(snap);
    expect(back.interp.placements.npc).toEqual({ x: 4, y: 6, dir: "left" });
    expect(back.interp.placements.other).toEqual({ x: 0, y: 0, dir: null });
    expect(back.interp.inputLocked).toBe(true);
    expect(canSave(restPlayer(), interp)).toBe(true);
  });

  test("loads a checksum-valid v1 save written before per-visit fields existed", () => {
    const current = JSON.parse(
      encodeEnvelope(createSnapshot("meadow", restPlayer(), createInterpState(), 0)),
    ) as Record<string, unknown> & { state: SaveSnapshot; checksum: string };
    const legacyInterp = current.state.interp as Omit<
      InterpState,
      "inputLocked" | "placements" | "pendingPlacements" | "pendingBattles"
    > & Partial<Pick<InterpState, "inputLocked" | "placements" | "pendingPlacements" | "pendingBattles">> & {
      pendingBattle?: null;
    };
    delete legacyInterp.inputLocked;
    delete legacyInterp.placements;
    delete legacyInterp.pendingPlacements;
    delete legacyInterp.pendingBattles;
    legacyInterp.pendingBattle = null;
    current.checksum = fnv1aText(canonicalJson(current.state));

    const restored = decodeEnvelopeText(JSON.stringify(current));
    expect(restored.interp.inputLocked).toBe(false);
    expect(restored.interp.placements).toEqual({});
    expect(restored.interp.pendingPlacements).toEqual([]);
    expect(restored.interp.pendingBattles).toEqual([]);
  });

  test("rejects a legacy populated pendingBattle slot as an unsafe save point", () => {
    const current = JSON.parse(
      encodeEnvelope(createSnapshot("meadow", restPlayer(), createInterpState(), 0)),
    ) as Record<string, unknown> & { state: SaveSnapshot; checksum: string };
    const legacyInterp = current.state.interp as unknown as Record<string, unknown>;
    delete legacyInterp.pendingBattles;
    legacyInterp.pendingBattle = { fiber: "meadow/old-battle", setup: { enemyHp: 1 } };
    current.checksum = fnv1aText(canonicalJson(current.state));

    // Hydration wraps the old slot into pendingBattles, after which the
    // ordinary save-point invariant rejects queued external work. Old
    // canSave never emitted this state, so accepting it cannot restore a
    // legitimate historical save.
    expect(() => decodeEnvelopeText(JSON.stringify(current))).toThrow(
      /state\.interp\.pendingBattles: no queued battles at a save point/,
    );
  });
});

describe("P1⑤ save — base64url save code", () => {
  test("uses only A-Z a-z 0-9 - _ (OSK-typeable), unpadded", () => {
    const code = encodeSaveCode(createSnapshot("m", restPlayer(), createInterpState(), 0));
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code).not.toContain("=");
    expect(code).not.toContain("+");
    expect(code).not.toContain("/");
    // The compressed prefix is followed by valid unpadded base64.
    expect(code.startsWith(SAVE_CODE_COMPRESSED_PREFIX)).toBe(true);
    expect((code.length - SAVE_CODE_COMPRESSED_PREFIX.length) % 4).not.toBe(1);
    const plain = encodeSaveCode(createSnapshot("m", restPlayer(), createInterpState(), 0), null, { compress: false });
    expect(plain).toMatch(/^e[A-Za-z0-9_-]+$/);
    expect(plain.length % 4).not.toBe(1);
  });

  test("round-trips rich state to the same snapshot an envelope load gives", () => {
    let interp = createInterpState(createSwitchState({ gold: 7 }));
    interp = foldInterp(interp, SIGNPOST_READ);
    const snap = createSnapshot("meadow", restPlayer(), interp, BTN.CIRCLE);
    const fromCode = decodeSaveCode(encodeSaveCode(snap));
    expect(fromCode).toEqual(snap);
    expect(encodeEnvelope(fromCode)).toBe(encodeEnvelope(snap));
    expect(fromCode.held).toBe(BTN.CIRCLE);
  });

  test("whitespace and newlines from a hand paste are tolerated", () => {
    const snap = createSnapshot("m", restPlayer(), createInterpState(), 0);
    const code = encodeSaveCode(snap);
    const pasted = code.match(/.{1,24}/g)!.join("\n") + "\n";
    expect(decodeSaveCode(pasted)).toEqual(snap);
    expect(decodeSaveCode(" " + code + " ")).toEqual(snap);
  });

  test("bad alphabet, corruption, truncation, and empty input are refused", () => {
    const snap0 = createSnapshot("m", restPlayer(), createInterpState(), 0);
    const code = encodeSaveCode(snap0);
    expect(() => decodeSaveCode("#" + code.slice(1))).toThrow(SaveError);
    expect(thrownCode(() => decodeSaveCode("#" + code.slice(1)))).toBe("bad-json");
    // Flip one payload character in the code's middle (the state JSON):
    // decoding yields a changed envelope, which the checksum must refuse.
    const mid = Math.floor(code.length / 2);
    const flipped = code.slice(0, mid) + (code[mid] === "A" ? "B" : "A") + code.slice(mid + 1);
    expect(["checksum", "bad-json", "shape"]).toContain(thrownCode(() => decodeSaveCode(flipped)));
    expect(() => decodeSaveCode(code.slice(0, code.length - 3))).toThrow(SaveError);
    expect(thrownCode(() => decodeSaveCode("   "))).toBe("bad-json");
  });
});

describe("P1⑤ save — fnv cross-check and canonical JSON", () => {
  test("fnv1a over UTF-8 matches the sim host on known vectors", () => {
    expect(fnv1aBytes(new Uint8Array())).toBe(simFnv1a(new Uint8Array()));
    const v1 = new Uint8Array([1, 2, 3, 255]);
    expect(fnv1aBytes(v1)).toBe(simFnv1a(v1));
    // Multibyte path: checksums over CJK event text.
    const zh = "宝箱";
    expect(fnv1aText(zh)).toBe(simFnv1a(new Uint8Array(Buffer.from(zh, "utf8"))));
  });

  test("canonical JSON sorts nested record keys; arrays keep order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson([{ z: 1 }, { y: 2 }])).toBe('[{"z":1},{"y":2}]');
  });
});

describe("P1⑤ save — slots and store", () => {
  test("slotPath is save/slot-N.json for 1..3 and throws outside", () => {
    expect(slotPath(1)).toBe("save/slot-1.json");
    expect(slotPath(3)).toBe("save/slot-3.json");
    expect(() => slotPath(0)).toThrow(/out of range/);
    expect(() => slotPath(4)).toThrow(/out of range/);
  });

  test("save/load over an in-memory store round-trips; empty slot refuses", () => {
    const store = memoryStore();
    const snap = createSnapshot("m", restPlayer(), createInterpState(), 0);
    saveToStore(store, 2, snap);
    expect(store.exists(2)).toBe(true);
    expect(loadFromStore(store, 2)).toEqual(snap);
    expect(thrownCode(() => loadFromStore(store, 1))).toBe("bad-json");
    const env = JSON.parse(store.read(2)!) as { format: string; frame: number };
    expect(env.format).toBe(SAVE_FORMAT);
    const summary = summarizeEnvelope(2, store.read(2)!);
    expect(summary).toMatchObject({ slot: 2, map: "m", frame: 0 });
  });

  test("overwriting a slot replaces the earlier snapshot", () => {
    const store = memoryStore();
    saveToStore(store, 1, createSnapshot("m1", restPlayer(), createInterpState(), 0));
    const interp = foldInterp(createInterpState(), SIGNPOST_READ);
    saveToStore(store, 1, createSnapshot("m2", restPlayer(), interp, 0));
    expect(loadFromStore(store, 1).map).toBe("m2");
    expect(loadFromStore(store, 1).interp.sw.switches["note-read"]).toBe(true);
  });
});

// F4/F5/F6 (task-1173): deep structural validation, slot summaries, UTF-8.
describe("P1⑤ save — deep structural validation (F4/1173)", () => {
  // A checksum-VALID envelope over a hand-mutated snapshot: recomputes the
  // FNV after mutation, so the checker must reject on STRUCTURE, not on the
  // checksum. This is exactly the attack shape the reviewer reproduced.
  function validEnvelope(): string {
    return encodeEnvelope(createSnapshot("meadow", restPlayer(), createInterpState(), 0));
  }
  function checksummed(mutate: (s: any) => void): string {
    const env = JSON.parse(validEnvelope()) as Record<string, unknown>;
    mutate((env as { state: any }).state);
    const state = (env as { state: unknown }).state;
    (env as { checksum: string }).checksum = fnv1aText(canonicalJson(state));
    return JSON.stringify(env);
  }

  test("a well-formed envelope validates", () => {
    expect(() => decodeEnvelopeText(validEnvelope())).not.toThrow();
  });

  const rejects = (name: string, mutate: (s: any) => void) =>
    test(`${name} is rejected as shape despite a valid checksum`, () => {
      expect(thrownCode(() => decodeEnvelopeText(checksummed(mutate)))).toBe("shape");
    });

  rejects("missing parallels", (s) => { delete s.interp.parallels; });
  rejects("missing erased", (s) => { delete s.interp.erased; });
  rejects("missing touched", (s) => { delete s.interp.touched; });
  rejects("facing out of range", (s) => { s.player.facing = 99; });
  rejects("negative tx", (s) => { s.player.tx = -1; });
  rejects("non-boolean moving", (s) => { s.player.moving = 1; });
  rejects("a mid-step phase", (s) => { s.player.phase = 3; });
  rejects("a pixel position off its tile origin", (s) => { s.player.px += 2; });
  rejects("an open modal", (s) => {
    s.interp.modal = { kind: "text", fiber: "x", lines: ["a"], total: 1, revealed: 1, complete: true };
  });
  rejects("a blocking main fiber", (s) => {
    s.interp.main = {
      key: "meadow/ev", pageIndex: 0, parallel: false,
      stack: [{ prog: [{ op: "exit" }], pc: 0 }], mode: "run", since: 0, erase: false,
    };
  });
  rejects("a parallel with a malformed stack", (s) => {
    s.interp.parallels["meadow/x"] = {
      key: "meadow/x", pageIndex: 0, parallel: true,
      stack: [{ prog: [{ op: "exit" }], pc: 5 }], mode: "run", since: 0, erase: false,
    };
  });
  rejects("a fiber key from another map", (s) => {
    s.interp.parallels["other/x"] = {
      key: "other/x", pageIndex: 0, parallel: true,
      stack: [{ prog: [{ op: "exit" }], pc: 0 }], mode: "run", since: 0, erase: false,
    };
  });
  rejects("an unknown instruction op", (s) => {
    s.interp.parallels["meadow/x"] = {
      key: "meadow/x", pageIndex: 0, parallel: true,
      stack: [{ prog: [{ op: "teleport" }], pc: 0 }], mode: "run", since: 0, erase: false,
    };
  });
  rejects("a non-finite gold", (s) => { s.interp.sw.gold = Infinity; });
  rejects("a bad rng cursor", (s) => { s.interp.sw.rng = -1; });
  rejects("a non-boolean switch", (s) => { s.interp.sw.switches.bogus = "yes"; });
  rejects("a bad self-switch value", (s) => { s.interp.sw.self["m/x"] = "Z"; });
  rejects("a leftover cue", (s) => { s.interp.cues = [{ name: "x", volume: 1, pitch: 1 }]; });
  rejects("a parked transfer", (s) => {
    s.interp.pendingTransfer = { fiber: "x", map: "m", x: 0, y: 0, dir: "keep", fadeFrames: 0 };
  });
  rejects("a bad held mask", (s) => { s.held = 1.5; });

  // --- per-visit state and compiled event-model ops ---------------------
  rejects("a non-boolean input lock", (s) => { s.interp.inputLocked = 1; });
  rejects("a placement with a bad dir", (s) => {
    s.interp.placements["meadow/x"] = { x: 1, y: 2, dir: "sideways" };
  });
  rejects("a placement with a negative tile", (s) => {
    s.interp.placements["meadow/x"] = { x: -1, y: 2, dir: null };
  });
  rejects("a non-empty pending placement queue", (s) => {
    s.interp.pendingPlacements.push({ eventId: "x", x: 1, y: 2, dir: null });
  });
  rejects("a malformed pending placement queue", (s) => {
    s.interp.pendingPlacements = null;
  });
  rejects("a facing condition with a bad dir", (s) => {
    parkParallel(s, {
      stack: [{
        prog: [
          { op: "if", cond: { kind: "facing", dir: "sideways" }, onFalse: 2 },
          { op: "exit" },
        ], pc: 0,
      }], mode: "run",
    });
  });
  rejects("a place instruction with a bad target", (s) => {
    parkParallel(s, {
      stack: [{ prog: [{ op: "place", target: 7, x: 0, y: 0, dir: null }, { op: "exit" }], pc: 0 }],
      mode: "run",
    });
  });

  // --- R1202-1: checksum-valid fibers that crash the NEXT frame ----------
  // Helper: park a parallel fiber for a live map event with an arbitrary
  // stack/mode. The validator must cross-check mode against the instruction
  // the unguarded reducer resumes against.
  function parkParallel(s: any, fiber: Record<string, unknown>): void {
    s.interp.parallels["meadow/signpost"] = {
      key: "meadow/signpost", pageIndex: 0, parallel: true,
      since: 0, erase: false, ...fiber,
    };
  }
  const transferProgram = (handoff: unknown) => [{
    op: "transfer",
    map: "next",
    x: 0,
    y: 0,
    dir: "keep",
    fadeFrames: 0,
    handoff,
  }, { op: "exit" }];
  for (const [name, handoff] of [
    ["a non-object transfer handoff", "seamless-v1"],
    ["a transfer handoff with a bad mode", { mode: "future", portalId: "door" }],
    ["a transfer handoff with an empty portal id", { mode: "seamless-v1", portalId: "" }],
  ] as const) {
    rejects(name, (s) => {
      parkParallel(s, {
        stack: [{ prog: transferProgram(handoff), pc: 0 }],
        mode: "run",
      });
    });
  }
  test("a compiled transfer with valid seamless provenance remains loadable", () => {
    const encoded = checksummed((s) => {
      parkParallel(s, {
        stack: [{
          prog: transferProgram({ mode: "seamless-v1", portalId: "west:east:safe" }),
          pc: 0,
        }],
        mode: "run",
      });
    });
    expect(() => decodeEnvelopeText(encoded)).not.toThrow();
  });
  test("a parallel program containing a cross-event path route remains loadable", () => {
    const encoded = checksummed((s) => {
      parkParallel(s, {
        stack: [{
          prog: [{
            op: "moveRoute",
            target: { event: "scout" },
            wait: false,
            route: {
              steps: [
                "turnTowardPlayer",
                { pathTo: { x: 8, y: 4, retries: 2 } },
                { approach: { target: "player", side: "left", distance: 1 } },
              ],
              repeat: false,
              skippable: false,
            },
          }, { op: "exit" }],
          pc: 0,
        }],
        mode: "run",
      });
    });
    expect(() => decodeEnvelopeText(encoded)).not.toThrow();
  });
  rejects("a wait fiber parked past its program", (s) => {
    parkParallel(s, { stack: [{ prog: [{ op: "wait", frames: 1 }], pc: 1 }], mode: "wait" });
  });
  rejects("a text fiber parked past its program", (s) => {
    parkParallel(s, { stack: [{ prog: [{ op: "text", lines: ["x"], cps: 30 }], pc: 1 }], mode: "text" });
  });
  rejects("a choices fiber parked past its program", (s) => {
    parkParallel(s, { stack: [{ prog: [{ op: "exit" }], pc: 1 }], mode: "choices" });
  });
  rejects("a fractional jmp target", (s) => {
    parkParallel(s, {
      stack: [{ prog: [{ op: "jmp", to: 0.5 }, { op: "exit" }], pc: 0 }], mode: "run",
    });
  });
  rejects("a fractional if false target", (s) => {
    parkParallel(s, {
      stack: [{
        prog: [{ op: "if", cond: { kind: "switch", id: "x" }, onFalse: 0.5 }, { op: "exit" }],
        pc: 0,
      }], mode: "run",
    });
  });
  rejects("a wait fiber parked on a non-wait instruction", (s) => {
    parkParallel(s, { stack: [{ prog: [{ op: "exit" }], pc: 0 }], mode: "wait" });
  });
  rejects("a text-mode fiber at a save point", (s) => {
    parkParallel(s, {
      stack: [{ prog: [{ op: "text", lines: ["x"], cps: 30 }], pc: 0 }], mode: "text",
    });
  });
  rejects("an external-mode fiber at a save point", (s) => {
    parkParallel(s, { stack: [{ prog: [{ op: "exit" }], pc: 0 }], mode: "external" });
  });
  rejects("a fiber whose key mismatches its dictionary key", (s) => {
    s.interp.parallels["meadow/signpost"] = {
      key: "meadow/gatepost", pageIndex: 0, parallel: true,
      stack: [{ prog: [{ op: "exit" }], pc: 0 }], mode: "run", since: 0, erase: false,
    };
  });
  rejects("an unknown condition kind", (s) => {
    parkParallel(s, {
      stack: [{
        prog: [{ op: "if", cond: { kind: "moonPhase" }, onFalse: 1 }, { op: "exit" }], pc: 0,
      }], mode: "run",
    });
  });
  rejects("a malformed move-route step", (s) => {
    parkParallel(s, {
      stack: [{
        prog: [{
          op: "moveRoute", target: "player", wait: false,
          route: { steps: ["moveSideways"], repeat: false, skippable: false },
        }, { op: "exit" }], pc: 0,
      }], mode: "run",
    });
  });
  rejects("an approach route with zero distance", (s) => {
    parkParallel(s, {
      stack: [{
        prog: [{
          op: "moveRoute", target: "player", wait: false,
          route: {
            steps: [{ approach: { target: { event: "scout" }, distance: 0 } }],
            repeat: false,
            skippable: false,
          },
        }, { op: "exit" }], pc: 0,
      }], mode: "run",
    });
  });
  rejects("a moveRoute missing its wait boolean", (s) => {
    parkParallel(s, {
      stack: [{
        prog: [{
          op: "moveRoute", target: "player",
          route: { steps: [], repeat: false, skippable: false },
        }, { op: "exit" }], pc: 0,
      }], mode: "run",
    });
  });

  // --- review 1274 B1: the structured compiler emits only FORWARD edges --
  // The Command vocabulary has no loop; compile() writes jmp.to and
  // if.onFalse strictly greater than the branch instruction. A self or
  // backward edge is a checksum-valid cycle that would otherwise run until
  // the per-frame runaway backstop (or hang an older build).
  rejects("a self jump (jmp.to == pc) is a cycle", (s) => {
    parkParallel(s, {
      stack: [{ prog: [{ op: "jmp", to: 0 }], pc: 0 }], mode: "run",
    });
  });
  rejects("a backward jump closing a loop is compiler-impossible", (s) => {
    parkParallel(s, {
      stack: [{
        prog: [
          { op: "switch", id: "x", value: true },
          { op: "jmp", to: 0 }, { op: "exit" },
        ],
        pc: 1,
      }], mode: "run",
    });
  });
  rejects("a self conditional (onFalse == pc) is a cycle", (s) => {
    parkParallel(s, {
      stack: [{
        prog: [{ op: "if", cond: { kind: "switch", id: "x" }, onFalse: 0 }, { op: "exit" }],
        pc: 0,
      }], mode: "run",
    });
  });
  rejects("a backward conditional is compiler-impossible", (s) => {
    parkParallel(s, {
      stack: [{
        prog: [
          { op: "switch", id: "x", value: true },
          { op: "if", cond: { kind: "switch", id: "y" }, onFalse: 0 },
          { op: "exit" },
        ],
        pc: 1,
      }], mode: "run",
    });
  });
  rejects("a fatal interpreter error state cannot be saved", (s) => {
    s.interp.error = { kind: "runaway", message: "interpreter: runaway program in m/x" };
  });

  test("a compiled page with nested if/else (forward edges only) still validates", () => {
    const events: MapDef["events"] = [{
      id: "clock", x: 1, y: 1,
      pages: [{ trigger: "parallel", sprite: null, commands: [
        { op: "if", if: { kind: "switch", id: "a" }, then: [
          { op: "switch", id: "b", value: true },
          { op: "if", if: { kind: "gold", amount: 1 }, then: [
            { op: "gold", set: "sub", amount: 1 },
          ], else: [{ op: "se", name: "coin", volume: 80, pitch: 100 }] },
        ], else: [{ op: "wait", seconds: 0.1 }] },
        { op: "exit" },
      ] }],
    }];
    const map: MapDef = { ...EXAMPLE_MAP, events };
    const world = createWorld(map, EXAMPLE_PROJECT.commonEvents ?? [], 60);
    let interp = createInterpState();
    interp = stepInterp(world, interp, { playerCell: START_CELL, prevCell: START_CELL, facing: 0 });
    const bytes = encodeEnvelope(createSnapshot(map.id, restPlayer(), interp, 0));
    expect(() => decodeEnvelopeText(bytes)).not.toThrow();
    // Re-encoding the decoded state is byte-identical: the healthy state
    // carries no error field, so the new runtime field does not change
    // legal save bytes.
    expect(encodeEnvelope(decodeEnvelopeText(bytes))).toBe(bytes);
  });

  test("a run-mode fiber sitting at pc == length is legal (frame-pop sentinel)", () => {
    const env = JSON.parse(validEnvelope()) as Record<string, unknown>;
    const state = (env as { state: any }).state;
    state.interp.parallels["meadow/signpost"] = {
      key: "meadow/signpost", pageIndex: 0, parallel: true,
      stack: [{ prog: [{ op: "wait", frames: 0 }, { op: "exit" }], pc: 2 }],
      mode: "run", since: 0, erase: false,
    };
    (env as { checksum: string }).checksum = fnv1aText(canonicalJson(state));
    expect(() => decodeEnvelopeText(JSON.stringify(env))).not.toThrow();
  });

  test("a live parallel wait fiber (a legal save) validates and resumes", () => {
    const events: MapDef["events"] = [{
      id: "clock", x: 1, y: 1,
      pages: [{ trigger: "parallel", sprite: null, commands: [
        { op: "wait", seconds: 0.5 }, { op: "exit" },
      ] }],
    }];
    const map: MapDef = { ...EXAMPLE_MAP, events };
    const world = createWorld(map, EXAMPLE_PROJECT.commonEvents ?? [], 60);
    let interp = createInterpState();
    interp = stepInterp(world, interp, { playerCell: START_CELL, prevCell: START_CELL, facing: 0 });
    expect(Object.keys(interp.parallels)).toHaveLength(1);
    const bytes = encodeEnvelope(createSnapshot(map.id, restPlayer(), interp, 0));
    expect(() => decodeEnvelopeText(bytes)).not.toThrow();
  });

  test("a mismatched envelope frame is rejected as shape (F5 cross-check)", () => {
    const env = JSON.parse(validEnvelope()) as Record<string, unknown>;
    env.frame = (env as { frame: number }).frame + 1;
    // Leave checksum over state (still valid): only the envelope frame lies.
    expect(thrownCode(() => decodeEnvelopeText(JSON.stringify(env)))).toBe("shape");
  });
});

describe("P1⑤ save — slot summary validation (F5/1173)", () => {
  test("summarizeEnvelope rejects a bad checksum or unsupported version", () => {
    const good = encodeEnvelope(createSnapshot("meadow", restPlayer(), createInterpState(), 0));
    expect(summarizeEnvelope(1, good).map).toBe("meadow");
    const badCk = JSON.parse(good) as Record<string, unknown>;
    badCk.checksum = "deadbeef";
    expect(thrownCode(() => summarizeEnvelope(1, JSON.stringify(badCk)))).toBe("checksum");
    const future = JSON.parse(good) as Record<string, unknown>;
    future.version = 2;
    expect(thrownCode(() => summarizeEnvelope(1, JSON.stringify(future)))).toBe("version");
  });
});

describe("P1⑤ save — strict UTF-8 save codes (F6/1173)", () => {
  test("valid multi-byte UTF-8 still round-trips", () => {
    const snap = createSnapshot("m", restPlayer(), createInterpState(), 0);
    expect(decodeSaveCode(encodeSaveCode(snap))).toEqual(snap);
  });

  // Every malformed code below uses only the OSK alphabet; the defect was
  // that String.fromCodePoint threw a RangeError instead of SaveError.
  const codeFor = (bytes: number[]): string => {
    const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i]!, b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0;
      const n = (b0 << 16) | (b1 << 8) | b2;
      out += B64URL[n >> 18]!;
      out += B64URL[(n >> 12) & 63]!;
      if (i + 1 < bytes.length) out += B64URL[(n >> 6) & 63]!;
      if (i + 2 < bytes.length) out += B64URL[n & 63]!;
    }
    return out;
  };
  const badUtf8: [string, number[]][] = [
    ["above U+10FFFF", [0xf7, 0xbf, 0xbf, 0xbf]],
    ["a surrogate U+D800", [0xed, 0xa0, 0x80]],
    ["an overlong 3-byte slash", [0xe0, 0x80, 0x2f]],
    ["an overlong 4-byte NUL", [0xf0, 0x80, 0x80, 0x80]],
    ["a missing continuation", [0xe4, 0xb8]],
    ["a stray continuation byte", [0x80]],
    ["a lead C1 (overlong ASCII)", [0xc1, 0x80]],
  ];
  for (const [name, bytes] of badUtf8) {
    test(`${name} raises typed bad-json`, () => {
      expect(thrownCode(() => decodeSaveCode(codeFor(bytes)))).toBe("bad-json");
    });
  }
});

// --- session state fingerprint (search dedup key) -------------------------------
//
// sessionStateFingerprint is the engine's own state-identity hash for the
// reach search's dedup key: the save-snapshot payload (map, player, the full
// interpreter state, ext) with between-fold transients dropped and pure
// playback clocks zeroed. It must (a) distinguish states that fold a
// different future — persistent audio intent most of all, since a
// bgmPlaying condition reads it — and (b) never mutate the state it hashes.

function fingerprintState(): SessionState {
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "fp",
    tileSize: 16,
    start: { map: "A", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "g", cols: 1, rows: 1 }],
    items: [],
    sprites: {},
    maps: [{
      id: "A", name: "A", width: 2, height: 2, sheets: ["g"],
      ground: ["g.0", "g.0", "g.0", "g.0"],
    }],
  };
  return startSession(project, createSession(project, 60, { extensions: { allowUnknown: true } }));
}

function withBgm(state: SessionState, id: string, positionTicks: number): SessionState {
  state.interp.audio = { bgm: { id, volume: 100, pitch: 100, positionTicks } };
  return state;
}

/** A state whose sole event is a parallel fiber parked in a long wait. */
function parallelWaitHarness(seconds: number): { session: Session; state: SessionState } {
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "fp-wait",
    tileSize: 16,
    start: { map: "A", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "g", cols: 1, rows: 1 }],
    items: [],
    sprites: {},
    maps: [{
      id: "A", name: "A", width: 2, height: 2, sheets: ["g"],
      ground: ["g.0", "g.0", "g.0", "g.0"],
      events: [{
        id: "timer", x: 0, y: 0,
        pages: [{ trigger: "parallel", commands: [{ op: "wait", seconds }] }],
      }],
    }],
  };
  const session = createSession(project, 60, { extensions: { allowUnknown: true } });
  return { session, state: startSession(project, session) };
}

const ZERO_INPUT = { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

/** The `since` anchor of the (single) parked parallel wait fiber. */
function parkedParallelSince(state: SessionState): number {
  const fibers = Object.values(state.interp.parallels);
  if (fibers.length !== 1 || fibers[0]!.mode !== "wait") {
    throw new Error("expected exactly one parked parallel wait fiber");
  }
  return fibers[0]!.since;
}

describe("session state fingerprint", () => {
  test("silence and a playing BGM hash differently", () => {
    const quiet = fingerprintState();
    const music = withBgm(fingerprintState(), "field", 0);
    expect(sessionStateFingerprint(music)).not.toBe(sessionStateFingerprint(quiet));
  });

  test("two different BGM tracks hash differently", () => {
    const a = withBgm(fingerprintState(), "field", 0);
    const b = withBgm(fingerprintState(), "battle", 0);
    expect(sessionStateFingerprint(a)).not.toBe(sessionStateFingerprint(b));
  });

  test("a paused BGM is distinct from a playing one", () => {
    const playing = withBgm(fingerprintState(), "field", 0);
    const paused = withBgm(fingerprintState(), "field", 0);
    paused.interp.audio!.bgm!.paused = true;
    expect(sessionStateFingerprint(paused)).not.toBe(sessionStateFingerprint(playing));
  });

  test("states differing only in playback position hash equal", () => {
    // BGM/BGS loop and no condition reads the position; the position is a
    // pure clock that advances every tick and must not split the dedup key.
    const a = withBgm(fingerprintState(), "field", 0);
    const b = withBgm(fingerprintState(), "field", 1234);
    expect(sessionStateFingerprint(a)).toBe(sessionStateFingerprint(b));
  });

  test("states differing only in the frame clock hash equal", () => {
    // The absolute frame counter advances every tick; with no fiber parked
    // on a time anchor, zeroing it loses no future. Parked fibers and
    // animation starts are rebased onto the zeroed clock by the same
    // normalization (see the tests below), so they keep their elapsed time.
    const a = fingerprintState();
    const b = fingerprintState();
    b.frame = 999;
    b.interp.frame = 999;
    expect(sessionStateFingerprint(a)).toBe(sessionStateFingerprint(b));
  });

  test("parallel waits at the same absolute anchor but different elapsed hash differently", () => {
    // A fiber's `since` is an absolute stamp on the same clock the key
    // zeroes: a wait completes when frame - since reaches its duration. Two
    // states parked at the same `since` but different frames have different
    // elapsed time and therefore different futures, so they must not share
    // a key. Zeroing the frame without rebasing `since` merged them and the
    // reach search dropped a real map.
    const { session, state } = parallelWaitHarness(60);
    let s = state;
    let at2: SessionState | undefined;
    let at32: SessionState | undefined;
    for (let f = 1; f <= 32; f++) {
      s = stepSession(session, s, ZERO_INPUT);
      if (f === 2) at2 = structuredClone(s);
      if (f === 32) at32 = structuredClone(s);
    }
    expect(parkedParallelSince(at2!)).toBe(parkedParallelSince(at32!));
    expect(sessionStateFingerprint(at2!)).not.toBe(sessionStateFingerprint(at32!));
  });

  test("parallel waits at the same elapsed time hash equal", () => {
    // Same elapsed wait (frame - since) means the same future: a state
    // reached at frame 2/since 1 and one at frame 102/since 101 must merge,
    // or the search explores every path twice and burns its frame budget.
    const { session, state } = parallelWaitHarness(60);
    let s = state;
    for (let f = 1; f <= 2; f++) s = stepSession(session, s, ZERO_INPUT);
    const at2 = structuredClone(s);
    const later = structuredClone(s) as SessionState;
    const fiber = Object.values(later.interp.parallels)[0]!;
    later.frame = 102;
    later.interp.frame = 102;
    fiber.since = 101;
    expect(sessionStateFingerprint(at2)).toBe(sessionStateFingerprint(later));
  });

  test("map animation starts are rebased with the frame clock", () => {
    // pruneMapAnims ends a one-shot animation when frame - start reaches its
    // length, so `start` is an absolute anchor on the zeroed clock too: it
    // must be rebased like Fiber.since.
    const anim = (start: number) => ({
      id: "x", anim: "y", start, x: 0, y: 0, target: null, layer: "above" as const, loop: false,
    });
    const a = fingerprintState();
    a.interp.anims = [anim(0)];
    const b = fingerprintState();
    b.frame = 100;
    b.interp.frame = 100;
    b.interp.anims = [anim(100)];
    // Same elapsed (frame - start = 0): equal.
    expect(sessionStateFingerprint(a)).toBe(sessionStateFingerprint(b));
    // Different elapsed: distinct.
    const c = fingerprintState();
    c.frame = 50;
    c.interp.frame = 50;
    c.interp.anims = [anim(0)];
    expect(sessionStateFingerprint(a)).not.toBe(sessionStateFingerprint(c));
  });

  test("a story switch change changes the hash", () => {
    const a = fingerprintState();
    const b = fingerprintState();
    b.sw.switches["gate"] = true;
    expect(sessionStateFingerprint(a)).not.toBe(sessionStateFingerprint(b));
  });

  test("hashing does not mutate the input state", () => {
    // Regression: the audio normalization used to reassign a shared audio
    // object's track, zeroing the live state's playback position as a side
    // effect of computing the key. The frame/anchor rebasing must be just
    // as clean: the live fiber's `since` and the animation's `start` are
    // shared references the key normalizes on copies.
    const state = withBgm(fingerprintState(), "field", 42);
    state.frame = 7;
    state.interp.frame = 7;
    state.interp.anims = [{
      id: "x", anim: "y", start: 4, x: 0, y: 0, target: null, layer: "above", loop: false,
    }];
    sessionStateFingerprint(state);
    expect(state.interp.audio?.bgm?.positionTicks).toBe(42);
    expect(state.frame).toBe(7);
    expect(state.interp.frame).toBe(7);
    expect(state.interp.audio?.bgm?.id).toBe("field");
    expect(state.interp.anims?.[0]?.start).toBe(4);
  });

  test("hashing a parked parallel fiber does not mutate its anchor", () => {
    const { session, state } = parallelWaitHarness(60);
    const s = stepSession(session, state, ZERO_INPUT);
    const since = parkedParallelSince(s);
    sessionStateFingerprint(s);
    expect(parkedParallelSince(s)).toBe(since);
    expect(s.interp.frame).toBeGreaterThan(0);
  });
});

function memoryStore(): SaveStore {
  const files = new Map<string, string>();
  return {
    exists: (slot) => files.has(slotPath(slot)),
    read: (slot) => files.get(slotPath(slot)) ?? null,
    write: (slot, text) => {
      files.set(slotPath(slot), text);
    },
  };
}
