// tests/sunstone-game-sim.test.ts — P1④ integrated game proof over the
// deterministic wasm sim host: boots the built sunstone bundle and plays
// the village -> forest -> village round trip, asserting
//
//   1. TRANSFER  touch gates move the player between maps and back, with
//               the right landing tile/facing and a FRESH map interpreter;
//               switches survive the swap.
//   2. NPCS      the guard patrols on its authored route and wandering NPCs
//               move; two runs of the same inputs are byte-identical.
//   3. BUDGET    a transfer frame is a bounded burst (ground + upper
//               setImage + one display toggle), not the 1998-op
//               sliding-chunk burst the R1 review measured; steady walking
//               stays one setPropBatch per frame.
//   4. PIXELS    pinned FNV-1a frame hashes cross-checked against committed
//               wasm-oracle PNGs (tests/goldens/sunstone-game.*); idle
//               frames freeze.
//   5. DETERM.   every tape run twice hashes byte-identically.
//
// Navigation reads the guest's own session state (globalThis.__rpgSessionState)
// and the host-built passage tables, so wandering NPCs cannot make a fixed
// tape flaky: each boundary picks a held direction toward the target.

import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { fnv1a, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { buildGame } from "../examples/sunstone/game-data.ts";
import { createSession } from "../src/engine/session.ts";
import { canStepFrom } from "../src/engine/passability.ts";
import type { Dir4 } from "../src/engine/passability.ts";
import type { SessionState } from "../src/engine/session.ts";
import { bootGameWorld, installGameSimIsolation } from "./helpers/sim-session.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";

// Without the built bundle/wasm these host tests cannot boot; register
// them as skips with the build command printed once.
const preflight = appPreflight("sunstone");
if (!preflight.ok) console.warn(`sunstone sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

installGameSimIsolation();

const COUNTED = [
  "createNode", "destroyNode", "insertBefore", "removeChild", "setStyle",
  "setProp", "setPropBatch", "setText", "replaceText", "setImage",
  "setSprite", "uploadTexture", "uploadImgEntry", "freeTexture",
  "loadTileTexture", "animate",
] as const;
type Counts = Record<(typeof COUNTED)[number], number>;
const zero = (): Counts => Object.fromEntries(COUNTED.map((o) => [o, 0])) as Counts;

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const DIR_BTN: Record<Dir4, number> = { 0: BTN.DOWN, 1: BTN.LEFT, 2: BTN.UP, 3: BTN.RIGHT } as const;

const { project } = buildGame();
const SESS = createSession(project);

interface FrameRec {
  s: SessionState;
  hash: string;
  ops: Counts;
}

let activeProbes: (() => { state: SessionState }) | undefined;

async function boot(premove = true): Promise<{
  world: SimWorld;
  recs: FrameRec[];
  step: (buttons: number, edges?: { confirm?: boolean }) => FrameRec;
}> {
  const frameDelta = zero();
  const cumulative = zero();
  let mounted = false;
  const world = await bootGameWorld(appBundle("sunstone"), 60, undefined, (ops) => {
    for (const op of COUNTED) {
      const fn = (ops as Record<string, unknown>)[op];
      if (typeof fn !== "function") continue;
      (ops as Record<string, unknown>)[op] = (...args: unknown[]) => {
        cumulative[op]++;
        if (mounted) frameDelta[op]++;
        return (fn as (...a: unknown[]) => unknown).apply(ops, args);
      };
    }
  });
  activeProbes = world.probes;
  // The golden oracle (tests/golden.ts) treats the FIRST driven frame as
  // f0: the component mounts synchronously at eval, so its initial state is
  // already present. The fixed-tape hash tests use the same convention
  // (premove=false); greedy tests take one idle mount tick first.
  if (premove) {
    world.frame(0, 0x8080);
    world.tick();
  }
  mounted = true;

  const recs: FrameRec[] = [];
  const step = (buttons: number, edges?: { confirm?: boolean }): FrameRec => {
    // The guest derives pressed edges from held buttons itself; a confirm
    // edge for a dialog is delivered by pulsing CIRCLE on the buttons arg.
    for (const op of COUNTED) frameDelta[op] = 0;
    world.frame(edges?.confirm ? BTN.CIRCLE | buttons : buttons, 0x8080);
    world.tick();
    const s = structuredClone(world.probes().state);
    const rec: FrameRec = { s, hash: fnv1a(world.render()), ops: { ...frameDelta } };
    recs.push(rec);
    return rec;
  };
  return { world, recs, step };
}

const get = (): SessionState => {
  if (!activeProbes) throw new Error("rpgkit: no active game sim world");
  return structuredClone(activeProbes().state);
};

function free(s: SessionState, x: number, y: number, dir: Dir4): boolean {
  const table = SESS.tables.get(s.mapId)!;
  // The caller passes the destination cell; check the source cell's dirBlock
  // exit too, matching the mover's canStepFrom rule (review C13).
  if (!canStepFrom(table, x - DX[dir], y - DY[dir], dir)) return false;
  for (const ch of Object.values(s.chars.chars)) {
    if (x === ch.tx && y === ch.ty) return false;
    if (ch.moving && x === ch.tx + DX[ch.stepDir] && y === ch.ty + DY[ch.stepDir]) return false;
  }
  return true;
}

/** Hold a greedily-chosen direction until the player stands on (tx,ty) on
 *  the expected map. `after` lets a caller act (e.g. wait for a transfer). */
function walkTo(
  step: (b: number) => FrameRec,
  mapId: string,
  tx: number,
  ty: number,
  maxFrames = 900,
): { frame: number; rec: FrameRec } {
  let held = 0;
  for (let f = 0; f < maxFrames; f++) {
    const s = get();
    if (s.mapId === mapId && s.move.tx === tx && s.move.ty === ty && !s.move.moving) {
      return { frame: f, rec: { s, hash: "", ops: zero() } };
    }
    if (!s.move.moving) {
      const dx = tx - s.move.tx;
      const dy = ty - s.move.ty;
      const order: Dir4[] = Math.abs(dy) >= Math.abs(dx)
        ? [dy > 0 ? 0 : 2, dx > 0 ? 3 : 1]
        : [dx > 0 ? 3 : 1, dy > 0 ? 0 : 2];
      held = 0;
      for (const dir of order) {
        if (free(s, s.move.tx + DX[dir], s.move.ty + DY[dir], dir)) {
          held = DIR_BTN[dir];
          break;
        }
      }
    }
    const rec = step(held);
    void rec;
    if (s.mapId !== mapId && get().mapId === mapId) {
      // landed on the new map; re-check target on next iteration
    }
  }
  const end = get();
  throw new Error(`walkTo: never reached ${mapId}(${tx},${ty}); at ${end.mapId}(${end.move.tx},${end.move.ty})`);
}

/** Advance frames, pulsing confirm every other frame, until no blocking
 *  fiber and no fade remain (or `until(mapId)` becomes the current map). */
function settle(
  step: (b: number, e?: { confirm?: boolean }) => FrameRec,
  opts: { maxFrames?: number; wantMap?: string } = {},
): FrameRec {
  const max = opts.maxFrames ?? 800;
  let confirm = true;
  let last = step(0);
  for (let i = 0; i < max; i++) {
    const s = get();
    if (s.interp.main === null && !s.fade && (!opts.wantMap || s.mapId === opts.wantMap)) {
      return last;
    }
    last = step(0, { confirm: confirm ? true : undefined });
    confirm = !confirm;
  }
  throw new Error("settle: timed out");
}

simDescribe("sunstone — village -> forest -> village transfers", () => {
  test("touch gates transfer the player between maps with the right landing", async () => {
    const { step } = await boot();
    expect(get().mapId).toBe("village");
    expect([get().move.tx, get().move.ty]).toEqual([9, 9]);

    // North road (9,0): route around the elder at (9,5) via column 8.
    walkTo(step, "village", 9, 1);
    const entered = step(BTN.UP); // onto the (9,0) gate pad
    void entered;
    const inForest = settle(step, { wantMap: "forest" });
    expect(inForest.s.mapId).toBe("forest");
    expect([inForest.s.move.tx, inForest.s.move.ty]).toEqual([10, 13]);
    expect(inForest.s.move.facing).toBe(2); // dir:"up"
    // the map interpreter is fresh
    expect(inForest.s.interp.frame).toBeGreaterThanOrEqual(0);

    // The forest-return pad is (9,13), one tile WEST of the (10,13)
    // landing; stepping onto it transfers immediately.
    for (let i = 0; i < 8; i++) step(BTN.LEFT);
    const back = settle(step, { wantMap: "village" });
    expect(back.s.mapId).toBe("village");
    expect([back.s.move.tx, back.s.move.ty]).toEqual([9, 1]);
    expect(back.s.move.facing).toBe(0); // dir:"down"
  });

  test("a switch set on one map survives a transfer to the other", async () => {
    // Covered at the reducer level in session.test; here assert the
    // guest fold shares one bank across the swap by reading it after the
    // real gate sequence (gold, seeded to 5 by the project, is unchanged by
    // the walk and survives the map change).
    const { step } = await boot();
    walkTo(step, "village", 9, 1);
    step(BTN.UP);
    const f = settle(step, { wantMap: "forest" });
    expect(f.s.sw.gold).toBe(5);
  });

  test("the round trip replays byte-for-byte across two runs", async () => {
    const drive = async (): Promise<string[]> => {
      const { step } = await boot();
      const hashes: string[] = [];
      walkTo(step, "village", 9, 1);
      step(BTN.UP);
      settle(step, { wantMap: "forest" });
      for (let i = 0; i < 8; i++) step(BTN.LEFT); // onto the (9,13) return pad
      settle(step, { wantMap: "village" });
      // capture a deterministic tail of idle hashes
      for (let i = 0; i < 8; i++) hashes.push(step(0).hash);
      return hashes;
    };
    const a = await drive();
    const b = await drive();
    expect(b).toEqual(a);
  });
});

simDescribe("sunstone — NPC motion is live and deterministic", () => {
  test("the guard patrol leaves and returns to its post; NPCs wander", async () => {
    const { step } = await boot();
    const start = get().chars.chars["guard"]!;
    expect([start.tx, start.ty]).toEqual([3, 7]);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      step(0);
      const g = get().chars.chars["guard"]!;
      seen.add(`${g.tx},${g.ty}`);
    }
    // The two-right/two-left beat visits (4,7) and (5,7), then returns.
    expect(seen.has("4,7")).toBe(true);
    expect(seen.has("5,7")).toBe(true);
    expect(seen.has("3,7")).toBe(true);
  });

  test("idle NPC motion over a fixed 300 frames is byte-identical across runs", async () => {
    const idleTape = async (): Promise<{ guard: unknown; boy: unknown }> => {
      const { step } = await boot();
      let last!: FrameRec;
      for (let i = 0; i < 300; i++) last = step(0);
      return {
        guard: last.s.chars.chars["guard"],
        boy: last.s.chars.chars["boy"],
      };
    };
    const a = await idleTape();
    const b = await idleTape();
    expect(b).toEqual(a);
  });
});

// The golden tape (PocketJS rpgkit-game spec): west to column 8, north past
// the elder, east back, onto the gate, arrive in the forest.
const TAPE_GAME: number[] = [
  ...Array<number>(8).fill(BTN.LEFT),
  ...Array<number>(64).fill(BTN.UP),
  ...Array<number>(8).fill(BTN.RIGHT),
  BTN.UP,
  ...Array<number>(14).fill(0),
];

simDescribe("sunstone — fixed transfer tape: pixels and op burst", () => {
  test("pinned framebuffer hashes match the committed wasm-oracle PNGs", async () => {
    const { step } = await boot(false);
    const hashes: string[] = [];
    for (const m of TAPE_GAME) hashes.push(step(m).hash);
    // FNV hashes captured on frames 2, 40, 94 (oracle convention f0 = first
    // driven frame). Cross-checked against tests/goldens/sunstone-game.*.
    const { decodePng } = await import("../vendor/pocketjs/framework/compiler/pak.ts");
    const pins: Record<number, string> = { 2: "90f6da43", 40: "39588bd7", 94: "819b11d0" };
    for (const [f, hash] of Object.entries(pins)) {
      const idx = Number(f);
      expect(hashes[idx], `frame ${f}`).toBe(hash);
      const png = new Uint8Array(
        await Bun.file(new URL(`./goldens/sunstone-game.${f}.png`, import.meta.url)).arrayBuffer(),
      );
      expect(fnv1a(decodePng(png).rgba), `frame ${f} PNG`).toBe(hash);
    }
    // The player ends in the forest at (10,13), facing up.
    expect(get().mapId).toBe("forest");
    expect([get().move.tx, get().move.ty]).toEqual([10, 13]);
    expect(get().move.facing).toBe(2);
  });

  test("the fixed tape replays byte-for-byte across two runs", async () => {
    const run = async (): Promise<{ hashes: string[]; states: SessionState[] }> => {
      const { step } = await boot(false);
      const hashes: string[] = [];
      const states: SessionState[] = [];
      for (const m of TAPE_GAME) {
        const r = step(m);
        hashes.push(r.hash);
        states.push(r.s);
      }
      return { hashes, states };
    };
    const a = await run();
    const b = await run();
    expect(b.hashes).toEqual(a.hashes);
    expect(b.states).toEqual(a.states);
  });

  test("the transfer frame is a bounded image/display burst (R1 measured 1998)", async () => {
    const { recs, step } = await boot(false);
    for (const m of TAPE_GAME) step(m);
    const swap = recs.findIndex((r) => r.s.mapId === "forest");
    expect(swap).toBeGreaterThan(-1);
    const burst = recs[swap]!.ops;
    const total = COUNTED.reduce((n, o) => n + burst[o], 0);
    // The 14-row destination fits one 512px upper chunk column, so the
    // row-sliced plane needs 14 source swaps. One ground slot plus nine
    // persistent event slots (including the hidden ambient-music event) make
    // the measured ceiling 14 * 1 + 1 + 9 = 24.
    expect(burst.setImage).toBeGreaterThanOrEqual(14);
    expect(burst.setImage).toBeLessThanOrEqual(24);
    // Rows, slices, and actor slots stay mounted through the transfer.
    expect(burst.createNode + burst.destroyNode).toBe(0);
    expect(burst.insertBefore + burst.removeChild).toBe(0);
    // Besides image swaps: one combined camera/actor position batch, five
    // changed depths, four geometry writes for one height-changing slot, and
    // six image/identity operations for three stable hidden event slots now
    // reserved for runtime appearance changes. The plane still does no
    // allocation or rebaking.
    expect(total).toBeLessThanOrEqual(40);
  });
});

simDescribe("sunstone — render budget", () => {
  test("steady walking commits one position batch per moved frame", async () => {
    // The first fixed-tape move is a clean west step from (9,9) on the open
    // road: the mid-step frame is exactly one setPropBatch, nothing else.
    const { recs, step } = await boot(false);
    step(BTN.LEFT);
    step(BTN.LEFT);
    step(BTN.LEFT);
    const mid = recs[2]!;
    expect(mid.ops.setPropBatch).toBe(1);
    expect(mid.ops.setImage).toBe(0);
    expect(COUNTED.reduce((n, o) => n + mid.ops[o], 0)).toBe(1);
  });

  test("a frame with nothing moving commits zero counted ops", async () => {
    // After the transfer, idle until both player and every NPC are at a
    // boundary; such a frame must emit nothing.
    const { step } = await boot(false);
    for (const m of TAPE_GAME) step(m);
    let zeroFrames = 0;
    for (let i = 0; i < 40; i++) {
      const r = step(0);
      const npcMoving = Object.values(r.s.chars.chars).some((c) => c.moving);
      if (!r.s.move.moving && !npcMoving && COUNTED.reduce((n, o) => n + r.ops[o], 0) === 0) {
        zeroFrames++;
      }
    }
    expect(zeroFrames).toBeGreaterThan(0);
  });

  test("mounts a small fixed node tree (ground, upper, NPC images, player, dialog host, fade)", async () => {
    const { world } = await boot();
    const count = (tree: unknown): number => {
      if (tree == null) return 0;
      const n = tree as { k?: unknown[] };
      let c = 1;
      for (const ch of n.k ?? []) c += count(ch);
      return c;
    };
    const nodes = count(world.getTree());
    // 13 NPC images across three map containers + ground/upper/player/root
    // + message host with text, choices, and shop panels mounted from boot
    // (hidden while unused) + fade measured 119 nodes after PR #1. A 130-node
    // cap leaves 11 nodes of headroom and stays far below the R1 558-node design.
    expect(nodes).toBeGreaterThan(20);
    expect(nodes).toBeLessThan(130);
  });

  test("artifact sizes: bounded pak and bundle", async () => {
    await boot();
    const pakBytes = statSync(appBundle("sunstone") + ".pak").size;
    const jsBytes = statSync(appBundle("sunstone") + ".js").size;
    // six 512x512 PSM_4444 map images (~3.1 MB) + 13 NPCs + player sprites
    expect(pakBytes).toBeGreaterThan(3_000_000);
    expect(pakBytes).toBeLessThan(3_500_000);
    // 297 KB against vendor/pocketjs 76ae741f: the game, the attract/
    // takeover/rewind controller and its frozen 539-frame tape, plus ~40 KB
    // of framework growth since the 780218d7 base the game was built on
    // (the meadow example grew by the same amount). The shared runtime every
    // game bundles has since grown by the streamed and animated map
    // renderers, both walker heights, the extended event model (areas,
    // compound and facing conditions, place, input lock) and the movement
    // extensions (one-sided passage, routes on any event, turn/pathTo/
    // approach, memoized passage cooking), the current-map actor plane with
    // row-sliced upper occlusion, the on-demand map repository with
    // deterministic staged transfer loading, the deterministic extension
    // registries with the battle lifecycle and scene host, and K4 (T2-10
    // shop command/UI, T2-9 scrolling >4-option choices, T2-16
    // variable-operand arithmetic, and fix 3's construction/restore/ext/
    // battle finite-state normalization), plus the shared bounded-keyframe
    // rewind path, the extension-driven dynamic-choice provider/resolver path,
    // the generic runtime appearance/layer render path, KM1's runtime movement
    // controls with their separately compiled legacy loop, KA1's state-driven
    // map animation layer, and KS1's shared screen effect, scripted camera,
    // backdrop and pooled balloon renderer, KAU1's shared audio state path,
    // AI2's optional trace, KB6 kept-alive scenes, battle audio restoration,
    // DEMO1's explicitly opted-in menu, save validation, chapter codes, tape
    // suffixes and live page hook, and 10,219 B of shared PocketJS code from
    // the upstream rebase, and KG1's generic scene host in the shared GameView:
    // 736,187 B before this port (5,196 B more from the ported PSP framework
    // work, about 18 KB from the scene host). Bounded immutable metadata,
    // opt-in session/interpreter caches, retained actor frames, and stable
    // dialog/battle paint paths and generic-scene merge guards add 31,070 B:
    // 767,170 B measured. Choice-row icons add 4,364 B of shared schema,
    // reducer and DialogBox hook code (the icon box itself is opt-in):
    // 771,534 B. The compatible schema identity list adds about 1 KB, and
    // applying same-tick place/route requests in command order adds 2,745 B;
    // demo tape providers, timelineFrame and the shared, windowed chapter tape
    // add 2,461 B of opted-in demo code: 777,762 B. Saving the current map's
    // characters, inflating compressed chapter codes, the overlay slot and
    // the save-input checks add 28,163 B: 805,925 B measured. CJK-aware text
    // layout in the shared boxes (8,921 B) and dialog pages and wrapped list
    // labels that never cut text (3,357 B) bring it, with the
    // streamed tile loader, to 822,635 B measured.
    // The loop/break commands, the eventTouch trigger and the {v:} text
    // token add shared interpreter/session/save-check code.
    // Replaceable interface words (the shared table and helpers, DialogBox's
    // shop words, GameView's legends and attract chrome, 3,653 B, and the
    // opted-in demo menu's words and wrapping, 2,307 B) join it, plus the
    // long-translation wrapping (5,686 B): 842,870 B measured.
    // The optional playerStep hook adds 1,218 B. The keyframe count cap,
    // shared immutable keyframes and the reused rollback checkpoint (with
    // its success-path resync), the attractRewindOptions helper and the
    // opted-in DemoOptions.rewind validation bring the merged product to
    // 847,053 B measured.
    // Integer chunk-window reuse and GameView's generic connected-world
    // factory seam (its concrete implementation is absent by input graph)
    // bring it to 840,064 B measured. KRM2's shared engine/compiler/save
    // state and GameView's generic opt-in presentation/host-action seams
    // bring it to 871,523 B. The KRM2 JSX remains outside this input graph
    // (krm2-ui-bundle-isolation.test.ts).
    // The W3 cache fixes (parsed-only rebuild, staged-preparation trim,
    // the falsy-rejection normalizer) and the coordinate-contract
    // promotion helper bring it to 873,965 B measured.
    // Merging the interface-text branch (uiText words, BoundedLine, bounded
    // SaveMenu/DialogBox/demo paths) brings the merged product to 898,897 B.
    // The seamless-v1 traversal identity, transfer provenance, sparse
    // reducer state and optional GameView resolver seam bring it to
    // 905,748 B measured; the concrete resolver remains opt-in.
    // The ui/demo and ui/audio input-graph tests separately prove
    // non-opted-in code stays out; the bound keeps a narrow margin so an
    // accidental bundle-in still trips it.
    // KRM3V's additive reducer/save support and the optional presentation
    // seams measure 917,053 B. Its concrete parallax and item-icon components
    // remain outside this input graph.
    // KRM3's label/selectItem/access/locationInfo/stopSe command handlers and
    // the SoundCue union add 12,272 B of shared interpreter code, measuring
    // 929,325 B; the select-item scene stays opt-in and absent. Seamless-
    // handoff fatal cleanup adds 440 B, and the KRM3 fix-2 engine changes
    // bring the merged product to 930,277 B. The KRM3 fix-4 engine changes
    // (single event-position source, frame-carried battle/scene completion
    // transfers, onDone save-validate) bring it to 932,110 B, and merging
    // the KRM3V/STUDIO4 follow-ups brings it to 932,941 B. The KRM3 fix-5
    // completion queue (an ordered onDone queue so a jump leaving a result
    // branch relocates the popped completions, innermost first, each firing
    // exactly once) plus the strict onDone save validation bring it to
    // 934,069 B (+1,128), and the fix-6 completion rules bring it to
    // 933,967 B (-102), and the cold-path performance work brings it to
    // 940,938 B (+6,971), and the opt-in {x:} text-token wiring brings it
    // to 943,366 B (+2,428). PocketJS upstream #514's packed touch-recorder
    // pages add 2,020 B of shared DevTools code (945,386 B), and GameView's
    // share of the connected-world neighbour preview plus the session's
    // left-map snapshot with its save validation, clone and restore bring
    // it to 950,374 B (+4,988). Keep a narrow margin so an accidental
    // bundle-in still trips it. The autosave command's shared exact-tick
    // snapshot/effect seam and in-flight player validation add 4,809 B,
    // measuring 955,183 B. The text command's optional layout (box
    // geometry, DialogBox placement/alignment/background, portrait-in-box
    // scaling, the sparse `box` and its save validation) adds 8,628 B,
    // measuring 963,811 B.
    expect(jsBytes).toBeLessThan(964_500);
  });
});

simDescribe("sim session isolation", () => {
  test("a later game boot makes the superseded world refuse input", async () => {
    const first = await boot(false);
    const second = await boot(false);
    expect(() => first.step(0)).toThrow(
      "sim: attempted to drive a superseded world",
    );
    expect(() => second.step(0)).not.toThrow();
  });
});

simDescribe("sunstone virtual time through the built package", () => {
  const drive = (world: SimWorld, buttons: number): void => {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  };

  async function worldAfter(hz: number, seconds: number): Promise<{ move: unknown; chars: unknown }> {
    const world = await bootGameWorld(appBundle("sunstone"), hz);
    for (let frame = 0; frame < hz * seconds; frame++) drive(world, 0);
    const state = structuredClone(world.probes().state);
    return {
      move: {
        tx: state.move.tx, ty: state.move.ty, px: state.move.px, py: state.move.py,
        facing: state.move.facing,
      },
      chars: state.chars,
    };
  }

  for (const seconds of [1, 4] as const) {
    test(`guard patrol and wanderers are byte-identical after ${seconds} virtual second(s) at 60/30/20/4 Hz`, async () => {
      const at60 = await worldAfter(60, seconds);
      for (const hz of [30, 20, 4] as const) {
        expect(await worldAfter(hz, seconds)).toEqual(at60);
      }
      if (seconds === 4) {
        const guard = (at60.chars as SessionState["chars"]).chars.guard!;
        expect([guard.tx, guard.ty]).not.toEqual([3, 7]);
        expect(guard.route!.pc).toBeGreaterThan(0);
      }
    });
  }

  test("button edges and interpreter time agree at 60/30/20/4 Hz", async () => {
    // Every segment is 30 reference ticks, a boundary shared by all four
    // host rates. The
    // tape walks north to the elder, opens the timed text, skips it, opens
    // the two-choice prompt, then moves its cursor down once.
    const segments = [
      [30, BTN.UP], [30, 0], [30, BTN.CIRCLE], [30, 0],
      [30, BTN.CIRCLE], [30, 0], [30, BTN.CIRCLE], [30, 0], [30, BTN.DOWN],
    ] as const;

    const runAt = async (hz: number) => {
      const world = await bootGameWorld(appBundle("sunstone"), hz);
      const checkpoints: Array<{ state: Omit<SessionState, "frame">; hash: string }> = [];
      for (const [ticks, buttons] of segments) {
        const frames = ticks / world.ticksPerFrame;
        expect(Number.isInteger(frames)).toBe(true);
        for (let frame = 0; frame < frames; frame++) drive(world, buttons);
        const { frame: _hostFrames, ...state } = structuredClone(world.probes().state);
        checkpoints.push({ state, hash: fnv1a(world.render()) });
      }
      return checkpoints;
    };

    const at60 = await runAt(60);
    for (const hz of [30, 20, 4] as const) expect(await runAt(hz)).toEqual(at60);

    const timed = at60[2]!.state.interp.modal;
    expect(timed).toMatchObject({ kind: "text", complete: false });
    if (timed?.kind !== "text") throw new Error("elder text did not open");
    expect(timed.revealed).toBeGreaterThan(0);
    expect(timed.revealed).toBeLessThan(timed.total);
    expect(at60.at(-1)!.state.move).toMatchObject({ tx: 9, ty: 6, moving: false });
    expect(at60.at(-1)!.state.interp.modal).toMatchObject({ kind: "choices", index: 1 });
  });
});
